import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  advanceRevisitDemoClock,
  getRevisitNow,
  resolveActiveRevisitScope,
  restoreRealRevisitClock,
  startRevisitDemoClock,
} from '@/lib/revisit/clock';
import { clearRevisitDatabase, listRevisitDemoSessions } from '@/lib/revisit/db';
import { demoRevisitScope, FORMAL_REVISIT_SCOPE } from '@/lib/revisit/scope';

describe('revisit virtual clock', () => {
  beforeEach(clearRevisitDatabase);
  afterEach(clearRevisitDatabase);

  it('uses the system clock for formal data and advances demos by whole hours', async () => {
    const realNow = 1_000_000;
    const session = await startRevisitDemoClock({
      stageId: 'stage-1',
      sessionId: 'demo-1',
      realNow,
    });
    await advanceRevisitDemoClock(session.id, 1, realNow);

    expect(await getRevisitNow(FORMAL_REVISIT_SCOPE, realNow)).toBe(realNow);
    expect(await getRevisitNow(demoRevisitScope(session.id), realNow)).toBe(
      realNow + 60 * 60 * 1000,
    );
  });

  it('only moves forward and caps a demo at seven days', async () => {
    const session = await startRevisitDemoClock({
      stageId: 'stage-1',
      sessionId: 'demo-1',
      realNow: 100,
    });
    await advanceRevisitDemoClock(session.id, 72, 100);
    await advanceRevisitDemoClock(session.id, -24, 100);
    const capped = await advanceRevisitDemoClock(session.id, 200, 100);

    expect(capped.offsetHours).toBe(168);
  });

  it('freezes archived demo time and creates a fresh batch for the next demo', async () => {
    const first = await startRevisitDemoClock({
      stageId: 'stage-1',
      sessionId: 'demo-1',
      realNow: 100,
    });
    await advanceRevisitDemoClock(first.id, 24, 100);
    await restoreRealRevisitClock(first.id, 100);

    expect(await getRevisitNow(demoRevisitScope(first.id), 999_999)).toBe(
      100 + 24 * 60 * 60 * 1000,
    );

    const second = await startRevisitDemoClock({
      stageId: 'stage-1',
      sessionId: 'demo-2',
      realNow: 200,
    });
    expect(second.id).not.toBe(first.id);
    expect((await listRevisitDemoSessions('stage-1')).map((item) => item.status)).toEqual([
      'active',
      'archived',
    ]);
  });

  it('keeps at most one active batch even after an interrupted settings update', async () => {
    await startRevisitDemoClock({ stageId: 'stage-1', sessionId: 'demo-1', realNow: 100 });
    await startRevisitDemoClock({ stageId: 'stage-1', sessionId: 'demo-2', realNow: 200 });

    const sessions = await listRevisitDemoSessions('stage-1');
    expect(
      sessions.filter((session) => session.status === 'active').map((item) => item.id),
    ).toEqual(['demo-2']);
  });

  it('keeps independent active clocks for different courses', async () => {
    const first = await startRevisitDemoClock({
      stageId: 'stage-1',
      sessionId: 'demo-1',
      realNow: 100,
    });
    await advanceRevisitDemoClock(first.id, 24, 100);
    const second = await startRevisitDemoClock({
      stageId: 'stage-2',
      sessionId: 'demo-2',
      realNow: 200,
    });
    await advanceRevisitDemoClock(second.id, 6, 200);

    expect(await listRevisitDemoSessions('stage-1')).toEqual([
      expect.objectContaining({ id: 'demo-1', status: 'active', offsetHours: 24 }),
    ]);
    expect(await listRevisitDemoSessions('stage-2')).toEqual([
      expect.objectContaining({ id: 'demo-2', status: 'active', offsetHours: 6 }),
    ]);
  });

  it('resolves the active demo scope from the current course only', () => {
    const activeByStage = {
      'stage-1': 'demo-1',
      'stage-2': 'demo-2',
    };

    expect(resolveActiveRevisitScope('stage-1', activeByStage)).toEqual({
      kind: 'demo',
      sessionId: 'demo-1',
    });
    expect(resolveActiveRevisitScope('stage-3', activeByStage)).toBe(FORMAL_REVISIT_SCOPE);
  });
});
