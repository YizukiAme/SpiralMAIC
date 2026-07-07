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
    });

    expect(prompt).not.toBeNull();
    expect(prompt?.system).toContain('exam blueprint');
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
});
