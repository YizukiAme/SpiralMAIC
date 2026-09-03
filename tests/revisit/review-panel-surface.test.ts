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
    panel: { description: string };
    tabs: { materials: string };
    studio: {
      title: string;
      createTitle: string;
      libraryTitle: string;
      emptyTitle: string;
      providerRequired: string;
    };
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

  it('puts an unfinished challenge action in the summary hero', () => {
    const historySource = reviewPanelSource.slice(
      reviewPanelSource.indexOf('function ReverseChallengeHistory('),
      reviewPanelSource.indexOf('function ReverseHistoryCard('),
    );

    expect(historySource).toContain(
      'unfinished ? onOpenAttempt(unfinished, dataScope) : requestNew()',
    );
    expect(historySource.indexOf('revisit.panel.suggestedReview')).toBeLessThan(
      historySource.indexOf('revisit.panel.createdAt'),
    );
  });

  it('uses one explanatory empty state instead of repeating the primary action', () => {
    const historySource = reviewPanelSource.slice(
      reviewPanelSource.indexOf('function ReverseChallengeHistory('),
      reviewPanelSource.indexOf('function ReverseHistoryCard('),
    );

    expect(historySource).toContain('attempts.length === 0');
    expect(historySource).toContain("t('revisit.history.awaitingCompletion')");
    expect(historySource).not.toContain('!unfinished ? (');
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
    expect(zhCn.revisit.panel.description).toBe('查看这门课的记忆状态、挑战记录与教学材料。');
  });

  it('does not show the version-retention helper sentence', () => {
    expect(studyStudioSource).not.toContain("t('revisit.studio.libraryDescription')");
  });

  it('shows existing materials before grouped creation choices', () => {
    expect(studyStudioSource.indexOf('study-studio-library-heading')).toBeLessThan(
      studyStudioSource.indexOf('study-studio-create-heading'),
    );
    expect(studyStudioSource).toContain('STUDY_ARTIFACT_CREATION_GROUP_IDS.map');
  });

  it('uses one provider setup banner and subdues blocked per-material actions', () => {
    expect(zhCn.revisit.studio.providerRequired).toBe('配置一次模型，即可生成下方任意教学材料。');
    expect(studyStudioSource).toContain("t('revisit.studio.providerRequired')");
    expect(studyStudioSource).toContain('disabled={disabled || pending || providerBlocked}');
  });
});
