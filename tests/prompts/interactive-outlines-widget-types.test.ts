import { describe, expect, test } from 'vitest';

import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';

function buildInteractiveOutlinesPrompt() {
  const prompt = buildPrompt(PROMPT_IDS.INTERACTIVE_OUTLINES, {
    requirement: 'Teach equipment inspection basics with interactive practice',
    pdfContent: 'None',
    availableImages: 'No images available',
    researchContext: 'None',
    teacherContext: '',
    userProfile: '',
  });
  expect(prompt).not.toBeNull();
  return `${prompt!.system}\n${prompt!.user}`;
}

describe('interactive-outlines widget type inventory', () => {
  test('preserves ordinary interactive widget types without procedural-skill as a candidate', () => {
    const text = buildInteractiveOutlinesPrompt();

    expect(text).toContain('simulation');
    expect(text).toContain('diagram');
    expect(text).toContain('code');
    expect(text).toContain('game');
    expect(text).toContain('visualization3d');
    expect(text).toContain('taskEngineMode');
    expect(text).toMatch(/Do not (select|output).*procedural-skill/i);
    expect(text).not.toContain('widgetType": "procedural-skill"');
    expect(text).not.toContain('procedureType');
  });

  test('routes vocational procedural practice away from ordinary Interactive Mode', () => {
    const text = buildInteractiveOutlinesPrompt();

    expect(text).toMatch(/procedural-skill.*taskEngineMode|taskEngineMode.*procedural-skill/i);
    expect(text).toMatch(/ordinary Interactive Mode/i);
    expect(text).toMatch(/diagram, simulation, or game|diagram, simulation, or game/i);
    expect(text).not.toContain('{{');
  });
});
