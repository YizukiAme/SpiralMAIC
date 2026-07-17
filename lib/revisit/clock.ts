import {
  archiveRevisitDemoSession,
  createRevisitDemoSession,
  listRevisitDemoSessions,
  updateRevisitDemoSessionClock,
} from '@/lib/revisit/db';
import { FORMAL_REVISIT_SCOPE, type RevisitDataScope } from '@/lib/revisit/scope';
import type { RevisitDemoSession } from '@/lib/revisit/types';

export const REVISIT_VIRTUAL_CLOCK_MAX_HOURS = 168;
export const REVISIT_VIRTUAL_CLOCK_MIN_STEP_HOURS = 1;
export const HOUR_MS = 60 * 60 * 1000;

export async function startRevisitDemoClock(args: {
  stageId: string;
  sessionId?: string;
  realNow?: number;
}): Promise<RevisitDemoSession> {
  const realNow = args.realNow ?? Date.now();
  const sessions = await listRevisitDemoSessions(args.stageId);
  for (const active of sessions.filter((session) => session.status === 'active')) {
    await archiveRevisitDemoSession(active.id, {
      offsetHours: active.offsetHours,
      simulatedAt: realNow + active.offsetHours * HOUR_MS,
      archivedAt: realNow,
    });
  }
  return createRevisitDemoSession({
    id: args.sessionId ?? crypto.randomUUID(),
    stageId: args.stageId,
    createdAt: realNow,
  });
}

export async function advanceRevisitDemoClock(
  sessionId: string,
  incrementHours: number,
  realNow = Date.now(),
): Promise<RevisitDemoSession> {
  const session = (await listRevisitDemoSessions()).find((item) => item.id === sessionId);
  if (!session || session.status !== 'active') throw new Error('Demo session is unavailable.');
  if (!Number.isFinite(incrementHours) || incrementHours <= 0) return session;
  const increment = Math.max(REVISIT_VIRTUAL_CLOCK_MIN_STEP_HOURS, Math.round(incrementHours));
  return updateRevisitDemoSessionClock(
    sessionId,
    Math.min(REVISIT_VIRTUAL_CLOCK_MAX_HOURS, session.offsetHours + increment),
    realNow,
  );
}

export async function restoreRealRevisitClock(
  sessionId: string,
  realNow = Date.now(),
): Promise<RevisitDemoSession> {
  const session = (await listRevisitDemoSessions()).find((item) => item.id === sessionId);
  if (!session) throw new Error('Demo session is unavailable.');
  return archiveRevisitDemoSession(sessionId, {
    offsetHours: session.offsetHours,
    simulatedAt: realNow + session.offsetHours * HOUR_MS,
    archivedAt: realNow,
  });
}

export async function getRevisitNow(
  scope: RevisitDataScope = FORMAL_REVISIT_SCOPE,
  realNow = Date.now(),
): Promise<number> {
  if (scope.kind === 'formal') return realNow;
  const session = (await listRevisitDemoSessions()).find((item) => item.id === scope.sessionId);
  if (!session) return realNow;
  if (session.status === 'archived') return session.simulatedAt ?? session.updatedAt;
  return realNow + session.offsetHours * HOUR_MS;
}

export function resolveActiveRevisitScope(
  stageId: string,
  activeDemoSessionByStage: Record<string, string>,
): RevisitDataScope {
  const activeDemoSessionId = activeDemoSessionByStage[stageId];
  return activeDemoSessionId
    ? { kind: 'demo', sessionId: activeDemoSessionId }
    : FORMAL_REVISIT_SCOPE;
}
