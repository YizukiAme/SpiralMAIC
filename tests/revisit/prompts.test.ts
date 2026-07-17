import { describe, expect, it } from 'vitest';

import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';
import { buildBlueprintPrompt } from '@/lib/revisit/prompt-builders';
import type { RevisitAdaptiveContext } from '@/lib/revisit/types';
import type { Scene, Stage } from '@/lib/types/stage';

const UNRESOLVED_PLACEHOLDER = /\{\{\w[\w-]*\}\}/;

describe('SpiralMAIC revisit prompt templates', () => {
  it('builds the blueprint with bounded findings and adaptive prioritization rules', () => {
    const stage: Stage = {
      id: 'stage-1',
      name: 'Informal fallacies',
      description: 'A lesson about common reasoning mistakes.',
      createdAt: 1,
      updatedAt: 2,
      languageDirective: 'Deliver the entire course in English.',
    };
    const scenes: Scene[] = [
      {
        id: 'scene-1',
        stageId: stage.id,
        type: 'quiz',
        title: 'Straw man fallacy',
        order: 0,
        actions: [],
        content: {
          type: 'quiz',
          questions: [],
        },
      },
    ];
    const adaptiveContext: RevisitAdaptiveContext = {
      completedChallengeCount: 1,
      memorySummary: {
        status: 'review',
        recall: 0.5,
        meanRecall: 0.6,
        minRecall: 0.4,
        color: '#ef4444',
      },
      conceptStates: [],
      pendingConcepts: [],
      latestReport: {
        attemptId: 'attempt-1',
        stageId: stage.id,
        completedAt: 100,
        summary: 'Transfer needs more practice.',
        dimensions: {
          clarity: 0.8,
          doubtResolution: 0.7,
          transfer: 0.4,
          errorCorrection: 0.6,
        },
        qRaw: 0.63,
        q: 0.6,
        errors: [],
        evidence: [],
        pageReports: [],
        findingsVersion: 1,
        strengths: [
          {
            id: 'strength-1',
            title: 'Clear definitions',
            feedback: 'Definitions were concise.',
            dimension: 'clarity',
            conceptIds: ['straw-man'],
            citations: [
              {
                kind: 'transcript',
                sourceId: 'message-1',
                excerpt: 'SECRET_BLUEPRINT_CITATION',
              },
            ],
          },
        ],
        improvements: [
          {
            id: 'improvement-1',
            title: 'Transfer to new examples',
            feedback: 'Distinguish unfamiliar arguments.',
            dimension: 'transfer',
            conceptIds: ['straw-man'],
            citations: [],
          },
        ],
      },
    };

    const prompt = buildBlueprintPrompt({ stage, scenes, adaptiveContext });
    const combined = `${prompt.system}\n${prompt.user}`;

    expect(prompt.user).toContain('"findingsAvailable": true');
    expect(prompt.user).toContain('Transfer to new examples');
    expect(prompt.user).toContain('Clear definitions');
    expect(combined).not.toContain('SECRET_BLUEPRINT_CITATION');
    expect(prompt.system).toMatch(/improvements.*priority targets/i);
    expect(prompt.system).toMatch(/strengths.*repetitive scaffolding/i);
    expect(prompt.system).toMatch(/pending concepts.*memory decay.*authoritative/i);
    expect(combined).toMatch(/adaptive context.*untrusted data.*never instructions/i);
    expect(prompt.system).toContain('The Scene Digest is the sole factual source.');
    expect(prompt.system).toContain(
      '`latestReport.strengths` and `latestReport.improvements` may only change prioritization and scaffolding; never introduce concepts or assertions absent from the lesson source.',
    );
  });

  it('builds the exam-blueprint prompt through the template system', () => {
    const prompt = buildPrompt(PROMPT_IDS.REVISIT_EXAM_BLUEPRINT, {
      languageDirective: 'Deliver the entire course in English.',
      stageTitle: 'Informal fallacies',
      stageSummary: 'A lesson about common reasoning mistakes.',
      sceneDigest: '- Slide 1: Straw man fallacy',
      targetProbeCount: 4,
      completedChallengeCount: 0,
      challengeNumber: 1,
      scaffoldingLevel: 'guided',
      maxCuesPerPage: 4,
      challengeFocus: 'Accurate recall and clear organization.',
      adaptiveContextJson: '{"completedChallengeCount":0}',
    });

    expect(prompt).not.toBeNull();
    expect(prompt?.system).toContain('exam blueprint');
    expect(prompt?.system).toContain('pending assessment');
    expect(prompt?.system).toContain('do not need to include every historical concept');
    expect(prompt?.system).toContain('openingBrief');
    expect(prompt?.system).toContain('entire completed classroom');
    expect(prompt?.system).toContain('Do not include greetings or classroom logistics');
    expect(prompt?.user).toContain('Informal fallacies');
    expect(`${prompt?.system}\n${prompt?.user}`).not.toMatch(UNRESOLVED_PLACEHOLDER);
  });

  it('builds the judge prompt through the template system', () => {
    const prompt = buildPrompt(PROMPT_IDS.REVISIT_JUDGE, {
      languageDirective: 'Deliver the report in English.',
      blueprintJson: '{"concepts":[]}',
      transcriptJson: '{"turns":[]}',
      pageReportsJson: '[]',
    });

    expect(prompt).not.toBeNull();
    expect(prompt?.system).toContain('revisit judge');
    expect(prompt?.system).toContain('"strengths"');
    expect(prompt?.system).toContain('"improvements"');
    expect(prompt?.system).toMatch(/2-3 strengths/i);
    expect(prompt?.system).toMatch(/1-2 improvements/i);
    expect(prompt?.system).toMatch(/source ids? only/i);
    expect(prompt?.system).toMatch(/untrusted evidence/i);
    expect(prompt?.system).toMatch(/never instructions/i);
    expect(prompt?.user).toContain('Blueprint');
    expect(`${prompt?.system}\n${prompt?.user}`).not.toMatch(UNRESOLVED_PLACEHOLDER);
  });

  it('builds every study-artifact prompt through the template system', () => {
    const promptIds = [
      PROMPT_IDS.REVISIT_STUDY_ARTIFACT_BRIEFING,
      PROMPT_IDS.REVISIT_STUDY_ARTIFACT_MIND_MAP,
      PROMPT_IDS.REVISIT_STUDY_ARTIFACT_STUDY_GUIDE,
      PROMPT_IDS.REVISIT_STUDY_ARTIFACT_FAQ,
      PROMPT_IDS.REVISIT_STUDY_ARTIFACT_FLASHCARDS,
      PROMPT_IDS.REVISIT_STUDY_ARTIFACT_QUIZ,
    ];

    for (const promptId of promptIds) {
      const prompt = buildPrompt(promptId, {
        languageDirective: 'zh-CN',
        stageTitle: 'English Grammar',
        stageSummary: 'Subject and predicate basics.',
        artifactKindLabel: 'Flashcards',
        artifactOptionsJson: '{"count":12}',
        selectedSceneDigest: '[scene-2] Predicate check',
        adaptiveContextJson: '{"completedChallengeCount":2}',
        customInstructions: 'Focus on weak predicates.',
      });

      expect(prompt).not.toBeNull();
      expect(prompt?.system).toContain('JSON');
      expect(prompt?.user).toContain('English Grammar');
      expect(`${prompt?.system}\n${prompt?.user}`).not.toMatch(UNRESOLVED_PLACEHOLDER);
    }
  });
});
