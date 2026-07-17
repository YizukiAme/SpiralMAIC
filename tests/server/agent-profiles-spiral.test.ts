import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const callLLM = vi.fn();

vi.mock('@/lib/ai/llm', () => ({
  callLLM: (...args: unknown[]) => callLLM(...args),
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: async () => ({
    model: {},
    modelString: 'test-model',
    thinkingConfig: undefined,
  }),
}));

import { POST } from '@/app/api/generate/agent-profiles/route';

function makeRequest(mode: 'course' | 'spiral' = 'spiral'): NextRequest {
  return new NextRequest('http://localhost/api/generate/agent-profiles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode,
      stageInfo: { name: 'Intro to Algebra' },
      sceneOutlines: [{ title: 'Linear equations', description: 'Explain balancing.' }],
      languageDirective: 'Respond in English.',
      availableAvatars: ['/a.png', '/b.png', '/c.png'],
    }),
  });
}

function agent(name: string, role: string, priority: number) {
  return {
    name,
    role,
    persona: `${name} persona.`,
    avatar: '/a.png',
    color: '#111111',
    priority,
  };
}

describe('agent-profiles route — Spiral mode', () => {
  beforeEach(() => callLLM.mockReset());

  it('generates one assistant and two students with Spiral IDs', async () => {
    callLLM.mockResolvedValue({
      text: JSON.stringify({
        agents: [
          agent('Ari', 'assistant', 7),
          agent('Bo', 'student', 5),
          agent('Cy', 'student', 4),
        ],
      }),
    });

    const response = await POST(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.agents).toHaveLength(3);
    expect(body.agents.every((item: { id: string }) => item.id.startsWith('spiral-'))).toBe(true);
    expect(callLLM.mock.calls[0]?.[0]).toMatchObject({
      prompt: expect.stringContaining('The user is the teacher'),
    });
  });

  it.each([
    {
      label: 'includes a teacher',
      agents: [
        agent('Teacher', 'teacher', 10),
        agent('Bo', 'student', 5),
        agent('Cy', 'student', 4),
      ],
    },
    {
      label: 'has no assistant',
      agents: [
        agent('Bo', 'student', 5),
        agent('Cy', 'student', 4),
        agent('Dee', 'student', 3),
      ],
    },
    {
      label: 'has only one student',
      agents: [agent('Ari', 'assistant', 7), agent('Bo', 'student', 5)],
    },
    {
      label: 'has four students',
      agents: [
        agent('Ari', 'assistant', 7),
        agent('Bo', 'student', 5),
        agent('Cy', 'student', 4),
        agent('Dee', 'student', 3),
        agent('Eli', 'student', 2),
      ],
    },
  ])('rejects a roster that $label', async ({ agents }) => {
    callLLM.mockResolvedValue({ text: JSON.stringify({ agents }) });

    const response = await POST(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.success).toBe(false);
  });

  it('keeps the existing course-mode ID and teacher contract', async () => {
    callLLM.mockResolvedValue({
      text: JSON.stringify({
        agents: [agent('Teacher', 'teacher', 10), agent('Bo', 'student', 5)],
      }),
    });

    const response = await POST(makeRequest('course'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.agents[0].id).toMatch(/^gen-/);
  });
});
