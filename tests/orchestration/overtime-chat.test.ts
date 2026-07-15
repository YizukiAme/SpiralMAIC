import { describe, expect, it } from 'vitest';

import { getOvertimeAgentActions, validateOvertimeChatContext } from '@/lib/overtime/chat';
import { selectOvertimeInstructorIds } from '@/lib/orchestration/director-graph';
import { buildStructuredPrompt } from '@/lib/orchestration/prompt-builder';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { StatelessChatRequest } from '@/lib/types/chat';

const teacher: AgentConfig = {
  id: 'teacher',
  name: 'Teacher',
  role: 'teacher',
  persona: 'Helpful teacher.',
  avatar: '',
  color: '#000',
  allowedActions: [],
  priority: 10,
  createdAt: new Date(),
  updatedAt: new Date(),
  isDefault: false,
};

const storeState: StatelessChatRequest['storeState'] = {
  stage: { id: 'stage-1', name: 'Course', createdAt: 1, updatedAt: 2 },
  scenes: [],
  currentSceneId: '__pending__',
  mode: 'playback',
  whiteboardOpen: false,
};

const overtimeContext = {
  stageId: 'stage-1',
  entry: 'course_complete' as const,
  formal: true as const,
};

describe('overtime chat constraints', () => {
  it('accepts only a formal completion or a matching overtime page', () => {
    expect(validateOvertimeChatContext(overtimeContext, storeState)).toEqual(overtimeContext);
    expect(
      validateOvertimeChatContext({ ...overtimeContext, formal: false as never }, storeState),
    ).toBeUndefined();
    expect(
      validateOvertimeChatContext(overtimeContext, {
        ...storeState,
        currentSceneId: 'ordinary-scene',
      }),
    ).toBeUndefined();
  });

  it('routes overtime to the highest-priority teacher, then an assistant, never a student', () => {
    const agents = [
      { id: 'student', role: 'student', priority: 99 },
      { id: 'assistant', role: 'assistant', priority: 5 },
      { id: 'teacher-low', role: 'teacher', priority: 3 },
      { id: 'teacher-high', role: 'teacher', priority: 8 },
    ];
    expect(selectOvertimeInstructorIds(agents)).toEqual(['teacher-high']);
    expect(selectOvertimeInstructorIds(agents.filter((agent) => agent.role !== 'teacher'))).toEqual(
      ['assistant'],
    );
    expect(selectOvertimeInstructorIds(agents.filter((agent) => agent.role === 'student'))).toEqual(
      [],
    );
  });

  it('exposes the extension action and decision rules only to the overtime instructor', () => {
    expect(
      getOvertimeAgentActions(['spotlight', 'wb_open'], teacher.role, overtimeContext),
    ).toEqual(['request_learning_extension']);
    expect(getOvertimeAgentActions([], 'student', overtimeContext)).not.toContain(
      'request_learning_extension',
    );
    expect(getOvertimeAgentActions(['spotlight'], teacher.role)).toEqual(['spotlight']);

    const regularPrompt = buildStructuredPrompt(teacher, storeState);
    const overtimePrompt = buildStructuredPrompt(
      teacher,
      storeState,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      overtimeContext,
    );

    expect(regularPrompt).not.toContain('request_learning_extension');
    expect(overtimePrompt).toContain('request_learning_extension');
    expect(overtimePrompt).toContain('ordinary text answer');
    expect(overtimePrompt).toContain('exactly one durable classroom page');
    expect(overtimePrompt).toContain('new_course');
    expect(overtimePrompt).toContain('The original course is already complete');
    expect(overtimePrompt).toContain("Answer the learner's latest message directly");
    expect(overtimePrompt).toContain('Never greet the class');
    expect(overtimePrompt).toContain('send the learner back to page 1');
    expect(overtimePrompt).toContain('submits a generation request');
    expect(overtimePrompt).toContain('does not mean the page is ready');
    expect(overtimePrompt).toContain('being prepared');
    expect(overtimePrompt).toContain('application state is the only source of truth');
  });

  it('grounds the overtime instructor in the completed pages instead of only the course name', () => {
    const groundedPrompt = buildStructuredPrompt(
      teacher,
      {
        ...storeState,
        scenes: [
          {
            id: 'scene-2',
            stageId: 'stage-1',
            order: 1,
            title: '什么是谓语',
            type: 'slide',
            content: {
              type: 'slide',
              canvas: {
                elements: [{ type: 'text', content: '谓语表示主语的动作或状态' }],
              },
            },
            actions: [{ type: 'speech', text: '英语完整句子通常需要谓语动词。' }],
          },
          {
            id: 'scene-1',
            stageId: 'stage-1',
            order: 0,
            title: '什么是主语',
            type: 'slide',
            content: {
              type: 'slide',
              canvas: { elements: [{ type: 'text', content: '主语回答谁或什么' }] },
            },
            actions: [],
          },
        ] as StatelessChatRequest['storeState']['scenes'],
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      overtimeContext,
    );

    expect(groundedPrompt.indexOf('Page 1 | slide | 什么是主语')).toBeLessThan(
      groundedPrompt.indexOf('Page 2 | slide | 什么是谓语'),
    );
    expect(groundedPrompt).toContain('主语回答谁或什么');
    expect(groundedPrompt).toContain('谓语表示主语的动作或状态');
    expect(groundedPrompt).toContain('英语完整句子通常需要谓语动词');
    expect(groundedPrompt).not.toContain('scene-1');
    expect(groundedPrompt).not.toContain('scene-2');
  });
});
