import { describe, expect, it } from 'vitest';

import { parseDirectorDecision } from '@/lib/orchestration/director-prompt';

describe('parseDirectorDecision', () => {
  it('parses a flat agent decision', () => {
    const decision = parseDirectorDecision('{"next_agent":"default-1"}');
    expect(decision).toMatchObject({ nextAgentId: 'default-1', shouldEnd: false });
  });

  it('parses a flat END decision', () => {
    const decision = parseDirectorDecision('{"next_agent":"END"}');
    expect(decision).toMatchObject({ nextAgentId: null, shouldEnd: true });
  });

  it('parses a nested revisit_gate decision (regression: lazy regex truncated at first })', () => {
    // Verbatim payload from the 2026-07-08 production log that the old
    // /\{[\s\S]*?"next_agent"[\s\S]*?\}/ extraction truncated and failed on.
    const raw =
      '{"next_agent":"default-3","revisit_gate":{"status":"probe","page_index":0,"reason":"老师还未开始讲授虚拟语气的内容，只是在打招呼确认设备，需要学生回应并引导开始教学","next_probe_id":"什么是虚拟语气-probe-01","confidence":0.8}}';

    const decision = parseDirectorDecision(raw);

    expect(decision.nextAgentId).toBe('default-3');
    expect(decision.shouldEnd).toBe(false);
    expect(decision.revisitGate).toMatchObject({
      status: 'probe',
      pageIndex: 0,
      nextProbeId: '什么是虚拟语气-probe-01',
      confidence: 0.8,
    });
  });

  it('parses a decision wrapped in markdown fences and prose', () => {
    const raw =
      'Here is my decision:\n```json\n{"next_agent":"default-4","revisit_gate":{"status":"pass","page_index":2,"reason":"covered well","confidence":0.9}}\n```\nDone.';

    const decision = parseDirectorDecision(raw);

    expect(decision.nextAgentId).toBe('default-4');
    expect(decision.revisitGate).toMatchObject({ status: 'pass', pageIndex: 2 });
  });

  it('ends the round when content has no next_agent JSON', () => {
    const decision = parseDirectorDecision('I think the discussion should continue.');
    expect(decision).toMatchObject({ nextAgentId: null, shouldEnd: true });
  });

  it('ends the round on a non-string next_agent', () => {
    const decision = parseDirectorDecision('{"next_agent":42}');
    expect(decision).toMatchObject({ nextAgentId: null, shouldEnd: true });
  });
});
