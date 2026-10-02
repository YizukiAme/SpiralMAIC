/** READ-ONLY. Used only by the one-way importer for old formal Revisit data. Demo stays local. */
import Dexie from 'dexie';

import { REVISIT_DATABASE_NAME, RevisitDatabase } from '@/lib/revisit/db';

const RECORD_KEYS = {
  userConceptState: 'conceptId',
  conceptEvidence: 'id',
  examBlueprints: 'id',
  revisitReports: 'attemptId',
  lessonProgress: 'stageId',
  studyMaterials: 'id',
  studyArtifacts: 'id',
  studyPractice: 'artifactId',
  revisitAttempts: 'attemptId',
  lessonConcepts: 'conceptId',
} as const;

export type LegacyRevisitKind = keyof typeof RECORD_KEYS;

export interface LegacyRevisitRow {
  kind: LegacyRevisitKind;
  recordId: string;
  body: Record<string, unknown>;
}

/** One course's consistent old-browser snapshot. Opening may run the preserved Dexie upgrades. */
export async function readLegacyRevisitRows(stageId: string): Promise<LegacyRevisitRow[]> {
  if (!(await Dexie.exists(REVISIT_DATABASE_NAME))) return [];
  const database = new RevisitDatabase();
  const kinds = Object.keys(RECORD_KEYS) as LegacyRevisitKind[];
  try {
    await database.open();
    return await database.transaction(
      'r',
      kinds.map((kind) => database.table(kind)),
      async () => {
        const rows: LegacyRevisitRow[] = [];
        for (const kind of kinds) {
          const records = (await database
            .table(kind)
            .where('stageId')
            .equals(stageId)
            .toArray()) as Record<string, unknown>[];
          for (const body of records) {
            const recordId = body[RECORD_KEYS[kind]];
            if (typeof recordId !== 'string') continue;
            rows.push({ kind, recordId, body });
          }
        }
        return rows;
      },
    );
  } finally {
    database.close();
  }
}

/** Course ids referenced by formal records, including records whose old course is gone. */
export async function readLegacyRevisitStageIds(): Promise<string[]> {
  if (!(await Dexie.exists(REVISIT_DATABASE_NAME))) return [];
  const database = new RevisitDatabase();
  const kinds = Object.keys(RECORD_KEYS) as LegacyRevisitKind[];
  try {
    await database.open();
    return await database.transaction(
      'r',
      kinds.map((kind) => database.table(kind)),
      async () => {
        const ids: string[] = [];
        for (const kind of kinds) {
          const keys = await database.table(kind).orderBy('stageId').uniqueKeys();
          for (const key of keys) if (typeof key === 'string') ids.push(key);
        }
        return [...new Set(ids)].sort();
      },
    );
  } finally {
    database.close();
  }
}
