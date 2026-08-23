import { describe, expect, it } from 'vitest';
import type { LanguageModelUsage } from 'ai';
import { normalizeUsage, hasBillableTokens } from '@/lib/usage/normalize';

/**
 * Builds a minimal AI SDK v6 LanguageModelUsage object. Any field left
 * undefined exercises the "missing → 0" normalization path.
 */
function makeUsage(partial: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}): LanguageModelUsage {
  return {
    inputTokens: partial.inputTokens,
    outputTokens: partial.outputTokens,
    totalTokens: partial.totalTokens,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: partial.cacheReadTokens,
      cacheWriteTokens: partial.cacheWriteTokens,
    },
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: partial.reasoningTokens,
    },
  } as LanguageModelUsage;
}

describe('normalizeUsage', () => {
  it('extracts the v6 four-class token shape', () => {
    const result = normalizeUsage(
      makeUsage({
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
        reasoningTokens: 5,
      }),
    );
    expect(result).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheCreationTokens: 10,
      reasoningTokens: 5,
    });
  });

  it('fills missing fields with 0', () => {
    const result = normalizeUsage(makeUsage({ inputTokens: 9 }));
    expect(result).toEqual({
      inputTokens: 9,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
    });
  });

  it('handles a fully empty usage object', () => {
    const result = normalizeUsage(makeUsage({}));
    expect(result).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
    });
  });

  it('tolerates a null/undefined usage object', () => {
    expect(normalizeUsage(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
    });
  });
});

describe('hasBillableTokens', () => {
  it('returns false when every class is 0', () => {
    expect(
      hasBillableTokens({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
      }),
    ).toBe(false);
  });

  it('returns true when any billable class is non-zero', () => {
    expect(
      hasBillableTokens({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 5,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
      }),
    ).toBe(true);
  });
});
