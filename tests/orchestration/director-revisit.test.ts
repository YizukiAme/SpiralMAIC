import { describe, expect, test } from 'vitest';

import {
  hasAgentResponseAfterLatestHumanTurn,
  resolveDirectorDecisionForAvailableAgents,
} from '@/lib/orchestration/director-graph';
import type { AgentConfig } from '@/lib/orchestration/registry/types';

const studentLow: Pick<AgentConfig, 'id' | 'role' | 'priority'> = {
  id: 'student-low',
  role: 'student',
  priority: 1,
};

const studentHigh: Pick<AgentConfig, 'id' | 'role' | 'priority'> = {
  id: 'student-high',
  role: 'student',
  priority: 9,
};

const assistant: Pick<AgentConfig, 'id' | 'role' | 'priority'> = {
  id: 'assistant-1',
  role: 'assistant',
  priority: 7,
};

describe('revisit director decision fallback', () => {
  test('keeps ordinary classroom unknown-agent decisions as END', () => {
    const resolved = resolveDirectorDecisionForAvailableAgents({
      decision: { nextAgentId: 'teacher-1', shouldEnd: false },
      agents: [studentHigh, assistant],
      revisitMode: false,
    });

    expect(resolved).toEqual({
      nextAgentId: null,
      shouldEnd: true,
      cueUser: false,
      fallbackUsed: false,
    });
  });

  test('revisit mode falls back unknown teacher decisions to a student', () => {
    const resolved = resolveDirectorDecisionForAvailableAgents({
      decision: { nextAgentId: 'teacher-1', shouldEnd: false },
      agents: [studentLow, studentHigh, assistant],
      revisitMode: true,
    });

    expect(resolved).toMatchObject({
      nextAgentId: 'student-high',
      shouldEnd: false,
      cueUser: false,
      fallbackUsed: true,
    });
  });

  test('revisit pass must still route to a student acknowledgment before END', () => {
    const resolved = resolveDirectorDecisionForAvailableAgents({
      decision: {
        nextAgentId: null,
        shouldEnd: true,
        revisitGate: { status: 'pass', pageIndex: 0, reason: 'covered' },
      },
      agents: [studentLow, assistant],
      revisitMode: true,
    });

    expect(resolved).toMatchObject({
      nextAgentId: 'student-low',
      shouldEnd: false,
      cueUser: false,
      fallbackUsed: true,
    });
  });

  test('revisit rescue fallback routes to the assistant', () => {
    const resolved = resolveDirectorDecisionForAvailableAgents({
      decision: {
        nextAgentId: null,
        shouldEnd: true,
        revisitGate: { status: 'rescue', pageIndex: 0, reason: 'stuck' },
      },
      agents: [studentLow, assistant],
      revisitMode: true,
    });

    expect(resolved).toMatchObject({
      nextAgentId: 'assistant-1',
      shouldEnd: false,
      cueUser: false,
      fallbackUsed: true,
    });
  });

  test('revisit pass can end after an agent already acknowledged the teacher', () => {
    const resolved = resolveDirectorDecisionForAvailableAgents({
      decision: {
        nextAgentId: null,
        shouldEnd: true,
        revisitGate: { status: 'pass', pageIndex: 0, reason: 'acknowledged' },
      },
      agents: [studentLow, assistant],
      revisitMode: true,
      agentRespondedAfterLatestHuman: true,
    });

    expect(resolved).toEqual({
      nextAgentId: null,
      shouldEnd: true,
      cueUser: false,
      fallbackUsed: false,
    });
  });

  test('revisit pass does not treat older agent turns as a response to the latest teacher turn', () => {
    const messages = [
      { id: 'teacher-1', role: 'user', parts: [{ type: 'text', text: '第一轮' }] },
      { id: 'student-1', role: 'assistant', parts: [{ type: 'text', text: '懂了' }] },
      { id: 'teacher-2', role: 'user', parts: [{ type: 'text', text: '第二轮' }] },
    ] as Parameters<typeof hasAgentResponseAfterLatestHumanTurn>[0];

    expect(hasAgentResponseAfterLatestHumanTurn(messages)).toBe(false);

    const resolved = resolveDirectorDecisionForAvailableAgents({
      decision: {
        nextAgentId: null,
        shouldEnd: true,
        revisitGate: { status: 'pass', pageIndex: 0, reason: 'covered' },
      },
      agents: [studentLow, assistant],
      revisitMode: true,
      agentRespondedAfterLatestHuman: hasAgentResponseAfterLatestHumanTurn(messages),
    });

    expect(resolved).toMatchObject({
      nextAgentId: 'student-low',
      shouldEnd: false,
      cueUser: false,
      fallbackUsed: true,
    });
  });
});
