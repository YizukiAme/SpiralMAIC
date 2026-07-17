import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const reviewPanelSource = readFileSync(
  new URL('../../components/revisit/review-panel.tsx', import.meta.url),
  'utf8',
);
const studyStudioSource = readFileSync(
  new URL('../../components/revisit/studio/index.tsx', import.meta.url),
  'utf8',
);
const zhCn = JSON.parse(
  readFileSync(new URL('../../lib/i18n/locales/zh-CN.json', import.meta.url), 'utf8'),
) as {
  revisit: {
    tabs: { materials: string };
    studio: { title: string; createTitle: string; libraryTitle: string; emptyTitle: string };
  };
};

describe('Reverse Challenge low-benefit dialog', () => {
  it('does not offer replaying the latest Reverse from the warning dialog', () => {
    expect(reviewPanelSource).not.toContain("t('revisit.lowBenefit.replay')");
  });
});

describe('Reverse panel layout regression guard', () => {
  it('preserves the high-specificity desktop row override and its explanation', () => {
    expect(reviewPanelSource).toContain('specificity beats md:flex-row');
    expect(reviewPanelSource).toContain('md:flex-row!');
  });
});

describe('Reverse history card interaction', () => {
  it('selects Reverse reports on hover and opens them on click', () => {
    const cardSource = reviewPanelSource.slice(
      reviewPanelSource.indexOf('function ReverseHistoryCard('),
      reviewPanelSource.indexOf('function AttemptDetails('),
    );

    expect(cardSource).toContain('onMouseEnter={selectCard}');
    expect(cardSource).toContain('onFocus={selectCard}');
    expect(cardSource).toContain('onClick={openCard}');
    expect(cardSource).not.toContain('onDoubleClick=');
  });
});

describe('Spiral panel material terminology', () => {
  it('uses 教学材料 for the primary panel labels', () => {
    expect(zhCn.revisit.tabs.materials).toBe('教学材料');
    expect(zhCn.revisit.studio).toMatchObject({
      title: '教学材料工作台',
      createTitle: '创建教学材料',
      libraryTitle: '我的教学材料',
      emptyTitle: '还没有教学材料',
    });
  });

  it('does not show the version-retention helper sentence', () => {
    expect(studyStudioSource).not.toContain("t('revisit.studio.libraryDescription')");
  });
});
