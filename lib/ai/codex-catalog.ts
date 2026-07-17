import type { ModelInfo, ThinkingCapability, ThinkingEffort } from '@/lib/types/provider';

export const CODEX_MODEL_CATALOG_LIMITS = {
  maxModels: 128,
  maxIdLength: 128,
  maxNameLength: 256,
  maxContextWindow: 10_000_000,
} as const;

export const CODEX_COMPATIBILITY_VERSION = '0.144.4';

const THINKING_EFFORTS = new Set<ThinkingEffort>([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : undefined;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export function isCodexThinkingEffort(value: unknown): value is ThinkingEffort {
  return typeof value === 'string' && THINKING_EFFORTS.has(value as ThinkingEffort);
}

export function buildCodexThinkingCapability(
  efforts: readonly ThinkingEffort[],
  defaultEffort?: ThinkingEffort,
): ThinkingCapability | undefined {
  const uniqueEfforts = [...new Set(efforts.filter(isCodexThinkingEffort))];
  if (uniqueEfforts.length === 0) return undefined;

  const toggleable = uniqueEfforts.includes('none');
  return {
    control: 'effort',
    requestAdapter: 'openai',
    defaultMode: toggleable ? 'disabled' : 'enabled',
    effortValues: uniqueEfforts,
    ...(defaultEffort && uniqueEfforts.includes(defaultEffort) ? { defaultEffort } : {}),
    toggleable,
    budgetAdjustable: true,
    defaultEnabled: !toggleable,
  };
}

/**
 * Reconstruct one client-safe Codex model. Unknown properties are deliberately
 * ignored so server DTOs and the persistent cache cannot inherit new upstream
 * fields by object spread.
 */
export function rebuildCodexModelInfo(value: unknown): ModelInfo | null {
  if (!isRecord(value)) return null;
  const id = boundedString(value.id, CODEX_MODEL_CATALOG_LIMITS.maxIdLength);
  const name = boundedString(value.name, CODEX_MODEL_CATALOG_LIMITS.maxNameLength);
  if (!id || !name) return null;

  let contextWindow: number | undefined;
  if (value.contextWindow !== undefined) {
    if (
      !Number.isInteger(value.contextWindow) ||
      (value.contextWindow as number) < 1 ||
      (value.contextWindow as number) > CODEX_MODEL_CATALOG_LIMITS.maxContextWindow
    ) {
      return null;
    }
    contextWindow = value.contextWindow as number;
  }

  const inputCapabilities = isRecord(value.capabilities) ? value.capabilities : {};
  const inputThinking = isRecord(inputCapabilities.thinking)
    ? inputCapabilities.thinking
    : undefined;
  const efforts = Array.isArray(inputThinking?.effortValues)
    ? inputThinking.effortValues.filter(isCodexThinkingEffort)
    : [];
  const defaultEffort = isCodexThinkingEffort(inputThinking?.defaultEffort)
    ? inputThinking.defaultEffort
    : undefined;
  const thinking = buildCodexThinkingCapability(efforts, defaultEffort);
  const serviceTiers =
    Array.isArray(inputCapabilities.serviceTiers) &&
    inputCapabilities.serviceTiers.includes('priority')
      ? (['priority'] as const)
      : undefined;

  return {
    id,
    name,
    ...(contextWindow ? { contextWindow } : {}),
    capabilities: {
      // Streaming and tools are properties of the local Responses transport,
      // not untrusted catalog claims.
      streaming: true,
      tools: true,
      ...(inputCapabilities.vision === true ? { vision: true } : {}),
      ...(thinking ? { thinking } : {}),
      ...(serviceTiers ? { serviceTiers: [...serviceTiers] } : {}),
    },
    source: 'probed',
  };
}

export function rebuildCodexModelCatalog(value: unknown): ModelInfo[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > CODEX_MODEL_CATALOG_LIMITS.maxModels
  ) {
    return null;
  }

  const rebuilt: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const model = rebuildCodexModelInfo(candidate);
    if (!model || seen.has(model.id)) return null;
    seen.add(model.id);
    rebuilt.push(model);
  }
  return rebuilt;
}

const BUNDLED_MODELS: readonly ModelInfo[] = deepFreeze([
  {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    contextWindow: 372_000,
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: buildCodexThinkingCapability(['low', 'medium', 'high', 'xhigh', 'max'], 'low'),
    },
    source: 'probed',
  },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    contextWindow: 372_000,
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: buildCodexThinkingCapability(['low', 'medium', 'high', 'xhigh', 'max'], 'medium'),
    },
    source: 'probed',
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    contextWindow: 372_000,
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: buildCodexThinkingCapability(['low', 'medium', 'high', 'xhigh', 'max'], 'medium'),
    },
    source: 'probed',
  },
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    contextWindow: 272_000,
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: buildCodexThinkingCapability(['low', 'medium', 'high', 'xhigh'], 'medium'),
    },
    source: 'probed',
  },
  {
    id: 'gpt-5.2',
    name: 'GPT-5.2',
    contextWindow: 272_000,
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: buildCodexThinkingCapability(['low', 'medium', 'high', 'xhigh'], 'medium'),
    },
    source: 'probed',
  },
] satisfies ModelInfo[]);

export function getBundledCodexModelCatalog(): ModelInfo[] {
  return rebuildCodexModelCatalog(BUNDLED_MODELS)!;
}
