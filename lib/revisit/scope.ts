export type RevisitDataScope = { kind: 'formal' } | { kind: 'demo'; sessionId: string };

export const FORMAL_REVISIT_SCOPE: RevisitDataScope = Object.freeze({ kind: 'formal' });

export function demoRevisitScope(sessionId: string): RevisitDataScope {
  return { kind: 'demo', sessionId };
}

export function serializeRevisitScope(scope: RevisitDataScope): string {
  return scope.kind === 'formal' ? 'formal' : `demo:${scope.sessionId}`;
}

export function parseRevisitScope(value: string | null | undefined): RevisitDataScope {
  if (value?.startsWith('demo:') && value.length > 5) {
    return demoRevisitScope(value.slice(5));
  }
  return FORMAL_REVISIT_SCOPE;
}
