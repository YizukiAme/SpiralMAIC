import Dexie, { type EntityTable } from 'dexie';

import type {
  ConceptEvidence,
  RevisitExamBlueprint,
  RevisitJudgeReport,
  UserConceptState,
} from '@/lib/revisit/types';
import {
  applyEvidenceToConceptState,
  createInitialConceptStates,
  DEFAULT_STABLE_SUCCESSES_REQUIRED,
} from '@/lib/revisit/memory';

export const REVISIT_DATABASE_NAME = 'SpiralMAIC-Revisit';

class RevisitDatabase extends Dexie {
  userConceptState!: EntityTable<UserConceptState, 'conceptId'>;
  conceptEvidence!: EntityTable<ConceptEvidence, 'id'>;
  examBlueprints!: EntityTable<RevisitExamBlueprint, 'id'>;
  revisitReports!: EntityTable<RevisitJudgeReport, 'attemptId'>;

  constructor() {
    super(REVISIT_DATABASE_NAME);

    this.version(1).stores({
      userConceptState:
        '[stageId+conceptId], stageId, conceptId, lastRetrievalAt, stableAt, updatedAt',
      conceptEvidence:
        'id, stageId, conceptId, attemptId, timestamp, [stageId+timestamp], [stageId+conceptId]',
      examBlueprints: 'id, stageId, generatedAt, sourceHash',
      revisitReports: 'attemptId, stageId, completedAt',
    });
  }
}

export const revisitDb = new RevisitDatabase();

export async function getLatestExamBlueprint(
  stageId: string,
): Promise<RevisitExamBlueprint | undefined> {
  const records = await revisitDb.examBlueprints.where('stageId').equals(stageId).toArray();
  return records.sort((a, b) => b.generatedAt - a.generatedAt)[0];
}

export async function saveExamBlueprint(blueprint: RevisitExamBlueprint): Promise<void> {
  await revisitDb.examBlueprints.put(blueprint);
}

export async function saveBlueprintAndInitializeState(
  blueprint: RevisitExamBlueprint,
  learnedAt = Date.now(),
): Promise<void> {
  const initialStates = createInitialConceptStates(blueprint, learnedAt);
  await revisitDb.transaction(
    'rw',
    [revisitDb.examBlueprints, revisitDb.userConceptState],
    async () => {
      await revisitDb.examBlueprints.put(blueprint);
      for (const initialState of initialStates) {
        const existing = await revisitDb.userConceptState.get([
          initialState.stageId,
          initialState.conceptId,
        ]);
        if (!existing) {
          await revisitDb.userConceptState.put(initialState);
        }
      }
    },
  );
}

export async function getConceptStates(stageId: string): Promise<UserConceptState[]> {
  return revisitDb.userConceptState.where('stageId').equals(stageId).toArray();
}

export async function saveConceptStates(states: UserConceptState[]): Promise<void> {
  if (states.length === 0) return;
  await revisitDb.userConceptState.bulkPut(states);
}

export async function saveEvidenceAndUpdateState(
  report: RevisitJudgeReport,
  options: {
    stableSuccessesRequired?: number;
    forgettingSpeedMultiplier?: number;
  } = {},
): Promise<void> {
  await revisitDb.transaction(
    'rw',
    [revisitDb.conceptEvidence, revisitDb.userConceptState, revisitDb.revisitReports],
    async () => {
      await revisitDb.revisitReports.put(report);
      if (report.evidence.length > 0) {
        await revisitDb.conceptEvidence.bulkPut(report.evidence);
      }

      for (const evidence of report.evidence) {
        const key = [evidence.stageId, evidence.conceptId] as [string, string];
        const existing = await revisitDb.userConceptState.get(key);
        const base =
          existing ??
          ({
            stageId: evidence.stageId,
            conceptId: evidence.conceptId,
            label: evidence.conceptId,
            hDays: 4,
            learnedAt: evidence.timestamp,
            lastRetrievalAt: evidence.timestamp,
            evidenceCount: 0,
            successChallengeDates: [],
            createdAt: evidence.timestamp,
            updatedAt: evidence.timestamp,
          } satisfies UserConceptState);
        await revisitDb.userConceptState.put(
          applyEvidenceToConceptState(base, evidence, {
            now: evidence.timestamp,
            stableSuccessesRequired:
              options.stableSuccessesRequired ?? DEFAULT_STABLE_SUCCESSES_REQUIRED,
            forgettingSpeedMultiplier: options.forgettingSpeedMultiplier,
          }),
        );
      }
    },
  );
}

export async function deleteRevisitStageData(stageId: string): Promise<void> {
  await revisitDb.transaction(
    'rw',
    [
      revisitDb.userConceptState,
      revisitDb.conceptEvidence,
      revisitDb.examBlueprints,
      revisitDb.revisitReports,
    ],
    async () => {
      await revisitDb.userConceptState.where('stageId').equals(stageId).delete();
      await revisitDb.conceptEvidence.where('stageId').equals(stageId).delete();
      await revisitDb.examBlueprints.where('stageId').equals(stageId).delete();
      await revisitDb.revisitReports.where('stageId').equals(stageId).delete();
    },
  );
}

export async function clearRevisitDatabase(): Promise<void> {
  await revisitDb.delete();
}
