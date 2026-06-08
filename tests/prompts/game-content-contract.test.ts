import { describe, expect, test } from 'vitest';

import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';

const UNRESOLVED_PLACEHOLDER = /\{\{[^}]+\}\}/;

function buildGamePrompt() {
  const prompt = buildPrompt(PROMPT_IDS.GAME_CONTENT, {
    title: 'GO / STOP Safety Decision Challenge',
    gameType: 'strategy',
    description:
      'Learners classify concrete inspection cases and decide whether work may continue.',
    keyPoints: [
      'Use visible decision cards',
      'Choose GO or STOP for each case',
      'Wrong choices explain unsafe consequences',
    ].join('\n'),
    scoring: { correctPoints: 10, speedBonus: 5 },
    languageDirective: 'Teach in English.',
  });

  expect(prompt).not.toBeNull();
  return `${prompt!.system}\n${prompt!.user}`;
}

describe('game content prompt contract', () => {
  test('requires a populated playable board after the intro screen', () => {
    const text = buildGamePrompt();

    expect(text).toMatch(/must not stop at an intro screen/i);
    expect(text).toMatch(/After (the learner )?clicks? Start/i);
    expect(text).toMatch(/board must populate visible playable objects/i);
    expect(text).toMatch(/derive at least 5 concrete playable objects/i);
    expect(text).toMatch(/Never leave target slots, boards, lanes, maps, or decision areas empty/i);
    expect(text).toMatch(
      /Every visible (playable )?object must have an interaction rule and feedback/i,
    );
    expect(text).toMatch(/5-8 concrete objects|5-8 concrete objects \/ cases \/ cards/i);
    expect(text).toMatch(/never (use )?fewer than 4 playable objects/i);
    expect(text).not.toMatch(UNRESOLVED_PLACEHOLDER);
  });
});
