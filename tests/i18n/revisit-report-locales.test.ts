import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const localeFiles = [
  'ar-SA.json',
  'en-US.json',
  'ja-JP.json',
  'ko-KR.json',
  'pt-BR.json',
  'ru-RU.json',
  'zh-CN.json',
  'zh-TW.json',
] as const;

const requiredReportKeys = [
  'overall',
  'strong',
  'needsWork',
  'summary',
  'strengths',
  'improvements',
  'evidence',
  'legacyEvidenceUnavailable',
  'transcriptEvidence',
  'pageEvidence',
  'radarLabel',
  'radarDescription',
  'errors',
  'noErrors',
  'corrected',
  'uncorrected',
  'pages',
  'passed',
  'notPassed',
  'probes',
] as const;

describe('Reverse report locale parity', () => {
  it.each(localeFiles)('%s provides the complete shared report vocabulary', (fileName) => {
    const locale = JSON.parse(
      readFileSync(new URL(`../../lib/i18n/locales/${fileName}`, import.meta.url), 'utf8'),
    ) as { revisit: { report: Record<string, unknown> } };

    for (const key of requiredReportKeys) {
      expect(locale.revisit.report[key], `${fileName}: revisit.report.${key}`).toBeTruthy();
    }
    expect(Object.keys(locale.revisit.report.dimensions as object)).toEqual([
      'clarity',
      'doubtResolution',
      'transfer',
      'errorCorrection',
    ]);
  });
});
