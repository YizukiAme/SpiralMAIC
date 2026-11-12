import { describe, expect, it } from 'vitest';
import {
  buildOvertimeChatContext,
  buildOvertimeRequestContext,
  validateOvertimeChatContext,
} from '@/lib/overtime/chat';
import type { StatelessChatRequest } from '@/lib/types/chat';
import type { Scene } from '@/lib/types/stage';

const overtimeScene = {
  id: 'overtime-extension-1',
  stageId: 'stage-1',
  title: 'Approach',
  type: 'slide',
  order: 3,
  content: {
    type: 'slide',
    canvas: {
      id: 'canvas-overtime',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: { backgroundColor: '#fff', themeColors: [], fontColor: '#111', fontName: 'Inter' },
      elements: [],
    },
  },
  actions: [],
  createdAt: 1,
  updatedAt: 1,
  overtime: {
    extensionId: 'extension-1',
    sequence: 1,
    teachingMove: 'extend',
    conceptIds: ['approach'],
    sourceSceneIds: ['scene-1'],
  },
} satisfies Scene;

describe('buildOvertimeChatContext', () => {
  it('opens overtime on a formal ordinary-course completion page without Spiral mode', () => {
    expect(
      buildOvertimeChatContext({
        stageId: 'stage-1',
        currentSceneId: '__pending__',
        scenes: [],
        generationComplete: true,
        activeDemoSessionId: null,
      }),
    ).toEqual({
      stageId: 'stage-1',
      entry: 'course_complete',
      formal: true,
    });

    expect(
      buildOvertimeChatContext({
        stageId: 'stage-1',
        currentSceneId: '__pending__',
        scenes: [],
        generationComplete: false,
        activeDemoSessionId: null,
      }),
    ).toBeUndefined();
  });

  it('re-derives completion at send time for legacy courses without a persisted completion flag', () => {
    expect(
      buildOvertimeRequestContext({
        stageId: 'stage-1',
        currentSceneId: '__pending__',
        scenes: [overtimeScene],
        generationComplete: false,
        outlineCount: 1,
        generatingOutlineCount: 0,
        activeDemoSessionId: null,
      }),
    ).toEqual({
      stageId: 'stage-1',
      entry: 'course_complete',
      formal: true,
    });
  });

  it('keeps overtime available on an appended page', () => {
    expect(
      buildOvertimeChatContext({
        stageId: 'stage-1',
        currentSceneId: overtimeScene.id,
        scenes: [overtimeScene],
        generationComplete: true,
        activeDemoSessionId: null,
      }),
    ).toEqual({
      stageId: 'stage-1',
      entry: 'overtime_page',
      formal: true,
    });
  });

  it('never exposes page generation while a Demo is active', () => {
    const base = {
      stageId: 'stage-1',
      currentSceneId: '__pending__',
      scenes: [] as Scene[],
      generationComplete: true,
      activeDemoSessionId: null as string | null,
    };
    expect(buildOvertimeChatContext(base)).toEqual({
      stageId: 'stage-1',
      entry: 'course_complete',
      formal: true,
    });
    expect(buildOvertimeChatContext({ ...base, activeDemoSessionId: 'demo-1' })).toBeUndefined();
  });
});

describe('overtime from the course-end overlay', () => {
  const first = { ...overtimeScene, id: 'first', overtime: undefined };
  const last = { ...overtimeScene, id: 'last', overtime: undefined };
  const base = {
    stageId: 'stage-1',
    currentSceneId: 'last',
    scenes: [first, last],
    generationComplete: true,
    activeDemoSessionId: null,
    outlineCount: 2,
    generatingOutlineCount: 0,
    courseEndOpen: true,
  };
  it('offers a formal extension at the new end overlay over the last real page', () => {
    expect(buildOvertimeRequestContext(base)).toEqual({
      stageId: 'stage-1',
      entry: 'course_complete',
      formal: true,
    });
  });
  it('does not enable a formal extension on earlier pages, during generation or in Demo', () => {
    expect(buildOvertimeRequestContext({ ...base, currentSceneId: 'first' })).toBeUndefined();
    expect(buildOvertimeRequestContext({ ...base, courseEndOpen: false })).toBeUndefined();
    expect(buildOvertimeRequestContext({ ...base, generatingOutlineCount: 1 })).toBeUndefined();
    expect(buildOvertimeRequestContext({ ...base, activeDemoSessionId: 'demo' })).toBeUndefined();
  });
  it('accepts the overlay context at the server boundary only on the last real page', () => {
    const context = { stageId: 'stage-1', entry: 'course_complete', formal: true };
    const state = {
      stage: { id: 'stage-1', name: 'Learning', createdAt: 1, updatedAt: 1 },
      scenes: [first, last],
      currentSceneId: 'last',
      mode: 'playback',
      whiteboardOpen: false,
    } satisfies StatelessChatRequest['storeState'];
    expect(validateOvertimeChatContext(context, state)).toEqual(context);
    expect(
      validateOvertimeChatContext(context, { ...state, currentSceneId: 'first' }),
    ).toBeUndefined();
    expect(validateOvertimeChatContext({ ...context, stageId: 'foreign' }, state)).toBeUndefined();
  });
});
