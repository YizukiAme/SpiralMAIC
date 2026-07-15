import { describe, expect, it } from 'vitest';

import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';

const UNRESOLVED_PLACEHOLDER = /\{\{\w[\w-]*\}\}/;

describe('SpiralMAIC revisit prompt templates', () => {
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
