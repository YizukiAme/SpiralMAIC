import { rebuildCodexModelCatalog } from '@/lib/ai/codex-catalog';

import { SAFE_MODEL_ID, exactKeys, fail, isRecord, jsonEqual } from './codex-acceptance-report';

export const ACCEPTANCE_SSE_MAX_BYTES = 2 * 1024 * 1024;
export const ACCEPTANCE_SSE_MAX_FRAME_BYTES = 256 * 1024;
export const ACCEPTANCE_SSE_MAX_FRAMES = 512;
export const ACCEPTANCE_SSE_MAX_DATA_LINES = 2_048;
export const ACCEPTANCE_SSE_MAX_EVENTS = 256;

export async function parseJsonSse(
  chunks: Iterable<string | Uint8Array> | AsyncIterable<string | Uint8Array>,
): Promise<unknown[]> {
  const events: unknown[] = [];
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let event = 'message';
  let data: string[] = [];
  let frameTouched = false;
  let frameBytes = 0;
  let totalBytes = 0;
  let frameCount = 0;
  let dataLineCount = 0;

  const dispatch = () => {
    if (frameTouched) {
      frameCount += 1;
      if (frameCount > ACCEPTANCE_SSE_MAX_FRAMES) fail('invalid-sse');
    }
    if (data.length > 0) {
      const payload = data.join('\n');
      if (!(event === 'close' && payload === '{}')) {
        if (events.length >= ACCEPTANCE_SSE_MAX_EVENTS) fail('invalid-sse');
        try {
          events.push(JSON.parse(payload));
        } catch {
          fail('invalid-sse');
        }
      }
    }
    event = 'message';
    data = [];
    frameTouched = false;
    frameBytes = 0;
  };

  const consumeLine = (lineWithPossibleCr: string) => {
    frameBytes += encoder.encode(lineWithPossibleCr).byteLength + 1;
    if (frameBytes > ACCEPTANCE_SSE_MAX_FRAME_BYTES) fail('invalid-sse');
    const line = lineWithPossibleCr.endsWith('\r')
      ? lineWithPossibleCr.slice(0, -1)
      : lineWithPossibleCr;
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    frameTouched = true;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value || 'message';
    else if (field === 'data') {
      dataLineCount += 1;
      if (dataLineCount > ACCEPTANCE_SSE_MAX_DATA_LINES) fail('invalid-sse');
      data.push(value);
    }
  };

  for await (const chunk of chunks) {
    const chunkBytes =
      typeof chunk === 'string' ? encoder.encode(chunk).byteLength : chunk.byteLength;
    totalBytes += chunkBytes;
    if (totalBytes > ACCEPTANCE_SSE_MAX_BYTES) fail('invalid-sse');
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      consumeLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  if (buffer) consumeLine(buffer);
  dispatch();
  return events;
}

export function validateOutlineEvents(events: readonly unknown[]): {
  eventCount: number;
  outlineCount: number;
  incremental: true;
  completed: true;
} {
  const terminalIndexes = events.flatMap((event, index) =>
    isRecord(event) && (event.type === 'done' || event.type === 'error') ? [index] : [],
  );
  if (terminalIndexes.length !== 1 || terminalIndexes[0] !== events.length - 1) {
    fail('invalid-sse');
  }

  const terminal = events.at(-1);
  if (!isRecord(terminal)) fail('invalid-sse');
  if (terminal.type === 'error') {
    if (
      !exactKeys(terminal, ['type', 'error']) ||
      typeof terminal.error !== 'string' ||
      terminal.error.trim().length === 0
    ) {
      fail('invalid-sse');
    }
    fail('upstream');
  }

  let outlines: Array<Record<string, unknown> & { id: string }> = [];
  for (const event of events.slice(0, -1)) {
    if (!isRecord(event)) fail('invalid-sse');
    if (event.type === 'retry') {
      if (
        !exactKeys(event, ['type', 'attempt', 'maxAttempts']) ||
        !Number.isSafeInteger(event.attempt) ||
        !Number.isSafeInteger(event.maxAttempts) ||
        (event.attempt as number) < 1 ||
        (event.maxAttempts as number) < (event.attempt as number)
      ) {
        fail('invalid-sse');
      }
      outlines = [];
    } else if (event.type === 'languageDirective' || event.type === 'courseTitle') {
      if (
        !exactKeys(event, ['type', 'data']) ||
        typeof event.data !== 'string' ||
        event.data.trim().length === 0
      ) {
        fail('invalid-sse');
      }
    } else if (event.type === 'outline') {
      const outline = event.data;
      if (
        !exactKeys(event, ['type', 'index', 'data']) ||
        event.index !== outlines.length ||
        !isValidOutline(outline) ||
        outlines.some((existing) => existing.id === outline.id)
      ) {
        fail('invalid-sse');
      }
      outlines.push(outline);
    } else {
      fail('invalid-sse');
    }
  }

  const terminalKeys = Object.prototype.hasOwnProperty.call(terminal, 'courseTitle')
    ? ['type', 'outlines', 'languageDirective', 'courseTitle', 'taskEngineMode']
    : ['type', 'outlines', 'languageDirective', 'taskEngineMode'];
  if (
    terminal.type !== 'done' ||
    !exactKeys(terminal, terminalKeys) ||
    outlines.length < 1 ||
    !Array.isArray(terminal.outlines) ||
    terminal.outlines.length !== outlines.length ||
    !terminal.outlines.every(isValidOutline) ||
    !jsonEqual(terminal.outlines, outlines) ||
    typeof terminal.languageDirective !== 'string' ||
    terminal.languageDirective.trim().length === 0 ||
    (terminal.courseTitle !== undefined &&
      (typeof terminal.courseTitle !== 'string' || terminal.courseTitle.trim().length === 0)) ||
    typeof terminal.taskEngineMode !== 'boolean'
  ) {
    fail('invalid-sse');
  }

  return {
    eventCount: events.length,
    outlineCount: outlines.length,
    incremental: true,
    completed: true,
  };
}

function isValidOutline(value: unknown): value is Record<string, unknown> & { id: string } {
  const allowedKeys = new Set([
    'id',
    'type',
    'title',
    'description',
    'keyPoints',
    'teachingObjective',
    'estimatedDuration',
    'order',
    'languageNote',
    'suggestedImageIds',
    'mediaGenerations',
    'quizConfig',
    'interactiveConfig',
    'pblConfig',
    'widgetType',
    'widgetOutline',
  ]);
  return Boolean(
    isRecord(value) &&
    Object.keys(value).every((key) => allowedKeys.has(key)) &&
    typeof value.id === 'string' &&
    SAFE_MODEL_ID.test(value.id) &&
    (value.type === 'slide' ||
      value.type === 'quiz' ||
      value.type === 'interactive' ||
      value.type === 'pbl') &&
    typeof value.title === 'string' &&
    value.title.trim().length > 0 &&
    typeof value.description === 'string' &&
    value.description.trim().length > 0 &&
    Array.isArray(value.keyPoints) &&
    value.keyPoints.length > 0 &&
    value.keyPoints.every((point) => typeof point === 'string' && point.trim().length > 0) &&
    Number.isSafeInteger(value.order) &&
    (value.order as number) >= 0 &&
    (value.teachingObjective === undefined ||
      (typeof value.teachingObjective === 'string' && value.teachingObjective.trim().length > 0)) &&
    (value.estimatedDuration === undefined ||
      (typeof value.estimatedDuration === 'number' &&
        Number.isFinite(value.estimatedDuration) &&
        value.estimatedDuration > 0)) &&
    (value.languageNote === undefined ||
      (typeof value.languageNote === 'string' && value.languageNote.trim().length > 0)) &&
    (value.suggestedImageIds === undefined ||
      (Array.isArray(value.suggestedImageIds) &&
        value.suggestedImageIds.every((id) => typeof id === 'string' && SAFE_MODEL_ID.test(id)))) &&
    (value.mediaGenerations === undefined || Array.isArray(value.mediaGenerations)) &&
    (value.quizConfig === undefined || isRecord(value.quizConfig)) &&
    (value.interactiveConfig === undefined || isRecord(value.interactiveConfig)) &&
    (value.pblConfig === undefined || isRecord(value.pblConfig)) &&
    (value.widgetType === undefined || typeof value.widgetType === 'string') &&
    (value.widgetOutline === undefined || isRecord(value.widgetOutline)),
  );
}

function assistantTextPresent(event: Record<string, unknown>): boolean {
  if (event.type !== 'message_update' && event.type !== 'message_end') return false;
  const message = isRecord(event.message) ? event.message : undefined;
  if (message?.role !== 'assistant') return false;
  const streamEvent = isRecord(event.assistantMessageEvent)
    ? event.assistantMessageEvent
    : undefined;
  if (typeof streamEvent?.delta === 'string' && streamEvent.delta.length > 0) return true;
  if (typeof message.content === 'string') return message.content.length > 0;
  return (
    Array.isArray(message.content) &&
    message.content.some(
      (part) => isRecord(part) && typeof part.text === 'string' && part.text.length > 0,
    )
  );
}

export function validateEditorEvents(events: readonly unknown[]): {
  eventCount: number;
  toolCallCount: number;
  toolCalled: true;
  toolCompleted: true;
  assistantContinued: true;
} {
  const terminalIndexes = events.flatMap((event, index) =>
    isRecord(event) && event.type === 'agent_end' ? [index] : [],
  );
  if (terminalIndexes.length !== 1 || terminalIndexes[0] !== events.length - 1) {
    fail('invalid-sse');
  }
  if (events.some((event) => !isRecord(event) || event.type === 'retry')) fail('invalid-sse');

  let toolCallId: string | undefined;
  let toolStartIndex = -1;
  let completionIndex = -1;
  let postToolTurnIndex = -1;
  let assistantContinued = false;

  events.forEach((event, index) => {
    if (!isRecord(event)) return;
    if (event.type === 'tool_execution_start' && event.toolName === 'read_scene_content') {
      if (
        typeof event.toolCallId !== 'string' ||
        event.toolCallId.length === 0 ||
        toolCallId !== undefined
      ) {
        fail('invalid-sse');
      }
      toolCallId = event.toolCallId;
      toolStartIndex = index;
      return;
    }
    if (event.type === 'tool_execution_end' && event.toolName === 'read_scene_content') {
      if (
        toolCallId === undefined ||
        event.toolCallId !== toolCallId ||
        event.isError !== false ||
        toolStartIndex >= index ||
        completionIndex >= 0
      ) {
        fail('invalid-sse');
      }
      completionIndex = index;
      return;
    }
    if (
      completionIndex >= 0 &&
      index > completionIndex &&
      event.type === 'turn_start' &&
      postToolTurnIndex < 0
    ) {
      postToolTurnIndex = index;
      return;
    }
    if (completionIndex >= 0 && assistantTextPresent(event)) {
      if (postToolTurnIndex < 0 || index <= postToolTurnIndex) fail('invalid-sse');
      assistantContinued = true;
    }
  });

  if (
    toolCallId === undefined ||
    completionIndex < 0 ||
    postToolTurnIndex < 0 ||
    !assistantContinued
  ) {
    fail('invalid-sse');
  }
  return {
    eventCount: events.length,
    toolCallCount: 1,
    toolCalled: true,
    toolCompleted: true,
    assistantContinued: true,
  };
}

export function validateCodexCatalog(value: unknown): {
  modelId: string;
  modelCount: number;
  fastModelCount: number;
  priorityAdvertised: boolean;
} {
  if (!isRecord(value) || value.success !== true || !isRecord(value.providers)) {
    fail('invalid-shape');
  }
  const provider = value.providers['openai-codex'];
  if (
    !isRecord(provider) ||
    !exactKeys(provider, ['models', 'fastModels', 'modelCatalog']) ||
    !Array.isArray(provider.models) ||
    !Array.isArray(provider.fastModels)
  ) {
    fail('invalid-shape');
  }
  const rebuilt = rebuildCodexModelCatalog(provider.modelCatalog);
  if (!rebuilt || !jsonEqual(provider.modelCatalog, rebuilt)) fail('invalid-shape');
  const modelIds = provider.models;
  const fastModelIds = provider.fastModels;
  if (
    !modelIds.every((id): id is string => typeof id === 'string' && SAFE_MODEL_ID.test(id)) ||
    !fastModelIds.every((id): id is string => typeof id === 'string' && SAFE_MODEL_ID.test(id)) ||
    !jsonEqual(
      modelIds,
      rebuilt.map((model) => model.id),
    )
  ) {
    fail('invalid-shape');
  }
  const priorityModels = rebuilt
    .filter((model) => model.capabilities?.serviceTiers?.includes('priority'))
    .map((model) => model.id);
  if (!jsonEqual(fastModelIds, priorityModels)) fail('invalid-shape');
  const selected = rebuilt.find((model) => priorityModels.includes(model.id)) ?? rebuilt[0];
  if (!selected || !SAFE_MODEL_ID.test(selected.id)) fail('invalid-shape');
  return {
    modelId: selected.id,
    modelCount: rebuilt.length,
    fastModelCount: priorityModels.length,
    priorityAdvertised: priorityModels.includes(selected.id),
  };
}

export function validateVerificationJson(value: unknown): { generated: true } {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['success', 'message', 'response']) ||
    value.success !== true ||
    typeof value.message !== 'string' ||
    typeof value.response !== 'string' ||
    value.response.trim().length < 1
  ) {
    fail('invalid-shape');
  }
  return { generated: true };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isBaseElement(value: Record<string, unknown>, line = false): boolean {
  return (
    isNonEmptyString(value.id) &&
    isFiniteNumber(value.left) &&
    isFiniteNumber(value.top) &&
    isFiniteNumber(value.width) &&
    (line || (isFiniteNumber(value.height) && isFiniteNumber(value.rotate)))
  );
}

function isNumberPair(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every(isFiniteNumber);
}

function isSupportedSlideElement(value: unknown): boolean {
  if (!isRecord(value) || !isNonEmptyString(value.type)) return false;
  if (value.type === 'line') {
    return Boolean(
      isBaseElement(value, true) &&
      isNumberPair(value.start) &&
      isNumberPair(value.end) &&
      (value.style === 'solid' || value.style === 'dashed' || value.style === 'dotted') &&
      isNonEmptyString(value.color) &&
      Array.isArray(value.points) &&
      value.points.length === 2 &&
      value.points.every((point) => point === '' || point === 'arrow' || point === 'dot'),
    );
  }
  if (!isBaseElement(value)) return false;
  switch (value.type) {
    case 'text':
      return (
        typeof value.content === 'string' &&
        isNonEmptyString(value.defaultFontName) &&
        isNonEmptyString(value.defaultColor)
      );
    case 'image':
      return typeof value.fixedRatio === 'boolean' && isNonEmptyString(value.src);
    case 'shape':
      return (
        isNumberPair(value.viewBox) &&
        isNonEmptyString(value.path) &&
        typeof value.fixedRatio === 'boolean' &&
        isNonEmptyString(value.fill)
      );
    case 'chart': {
      const data = isRecord(value.data) ? value.data : undefined;
      return Boolean(
        ['bar', 'column', 'line', 'pie', 'ring', 'area', 'radar', 'scatter'].includes(
          String(value.chartType),
        ) &&
        data &&
        Array.isArray(data.labels) &&
        data.labels.every((label) => typeof label === 'string') &&
        Array.isArray(data.legends) &&
        data.legends.every((legend) => typeof legend === 'string') &&
        Array.isArray(data.series) &&
        data.series.every(
          (series) => Array.isArray(series) && series.every((entry) => isFiniteNumber(entry)),
        ) &&
        Array.isArray(value.themeColors) &&
        value.themeColors.every((color) => isNonEmptyString(color)),
      );
    }
    case 'table':
      return Boolean(
        isRecord(value.outline) &&
        Array.isArray(value.colWidths) &&
        value.colWidths.every(isFiniteNumber) &&
        isFiniteNumber(value.cellMinHeight) &&
        Array.isArray(value.data) &&
        value.data.every(
          (row) =>
            Array.isArray(row) &&
            row.every(
              (cell) =>
                isRecord(cell) &&
                isNonEmptyString(cell.id) &&
                Number.isSafeInteger(cell.colspan) &&
                Number.isSafeInteger(cell.rowspan) &&
                typeof cell.text === 'string',
            ),
        ),
      );
    case 'latex':
      return isNonEmptyString(value.latex);
    case 'video':
      return typeof value.autoplay === 'boolean';
    case 'audio':
      return (
        typeof value.fixedRatio === 'boolean' &&
        isNonEmptyString(value.color) &&
        typeof value.loop === 'boolean' &&
        typeof value.autoplay === 'boolean' &&
        isNonEmptyString(value.src)
      );
    case 'code':
      return Boolean(
        isNonEmptyString(value.language) &&
        Array.isArray(value.lines) &&
        value.lines.every(
          (line) => isRecord(line) && isNonEmptyString(line.id) && typeof line.content === 'string',
        ),
      );
    default:
      return false;
  }
}

function isCanonicalGradient(value: unknown): boolean {
  return Boolean(
    isRecord(value) &&
    exactKeys(value, ['type', 'colors', 'rotate']) &&
    (value.type === 'linear' || value.type === 'radial') &&
    Array.isArray(value.colors) &&
    value.colors.length > 0 &&
    value.colors.every(
      (stop) =>
        isRecord(stop) &&
        exactKeys(stop, ['pos', 'color']) &&
        isFiniteNumber(stop.pos) &&
        isNonEmptyString(stop.color),
    ) &&
    isFiniteNumber(value.rotate),
  );
}

function isCanonicalSlideBackground(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === 'solid') {
    return exactKeys(value, ['type', 'color']) && isNonEmptyString(value.color);
  }
  if (value.type === 'image') {
    return Boolean(
      exactKeys(value, ['type', 'image']) &&
      isRecord(value.image) &&
      exactKeys(value.image, ['src', 'size']) &&
      isNonEmptyString(value.image.src) &&
      (value.image.size === 'cover' ||
        value.image.size === 'contain' ||
        value.image.size === 'repeat'),
    );
  }
  if (value.type === 'gradient') {
    return exactKeys(value, ['type', 'gradient']) && isCanonicalGradient(value.gradient);
  }
  return false;
}

export function validateSceneJson(value: unknown): {
  json: true;
  simpleScene: true;
  sceneCount: 1;
} {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['success', 'content', 'effectiveOutline']) ||
    value.success !== true ||
    !isRecord(value.content)
  ) {
    fail('invalid-shape');
  }
  const contentKeys = new Set(['elements', 'background', 'remark']);
  if (
    !Object.keys(value.content).every((key) => contentKeys.has(key)) ||
    !Array.isArray(value.content.elements) ||
    value.content.elements.length < 1 ||
    !value.content.elements.every(isSupportedSlideElement) ||
    (value.content.background !== undefined &&
      !isCanonicalSlideBackground(value.content.background)) ||
    (value.content.remark !== undefined && typeof value.content.remark !== 'string') ||
    !isRecord(value.effectiveOutline) ||
    !isValidOutline(value.effectiveOutline) ||
    value.effectiveOutline.type !== 'slide' ||
    value.effectiveOutline.id !== 'acceptance-outline'
  ) {
    fail('invalid-shape');
  }
  return { json: true, simpleScene: true, sceneCount: 1 };
}
