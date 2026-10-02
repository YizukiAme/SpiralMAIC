import type { RevisitDataScope } from '@/lib/revisit/scope';

/** Browser-facing formal Revisit operations always use the owner's server session. */
export function shouldUseFormalRevisitServer(scope: RevisitDataScope | undefined): boolean {
  return (
    (scope?.kind ?? 'formal') === 'formal' &&
    typeof window !== 'undefined' &&
    typeof window.fetch === 'function'
  );
}

export async function formalRevisitCall<T>(
  op: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await window.fetch('/api/spiral/revisit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ op, args }),
    signal,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `Revisit request failed (${response.status}).`);
  }
  const body = (await response.json()) as { result: T | null };
  return (body.result === null ? undefined : body.result) as T;
}
