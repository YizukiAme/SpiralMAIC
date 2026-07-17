import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  createEphemeralCodexLogicalSession,
  deriveCodexUpstreamSessionId,
  parseCodexLogicalSession,
  parseExternalCodexLogicalSession,
} from '@/lib/server/codex/logical-session';

function expectedUpstreamId(kind: string, id: string): string {
  return `oma_${createHash('sha256')
    .update(`openmaic-codex-session-v1\0${kind}\0${id}`, 'utf8')
    .digest('base64url')}`;
}

describe('Codex logical sessions', () => {
  it('derives the same namespaced upstream id across independent instances', () => {
    const first = deriveCodexUpstreamSessionId({ kind: 'chat', id: 'classroom-session-1' });
    const second = deriveCodexUpstreamSessionId({ kind: 'chat', id: 'classroom-session-1' });

    expect(first).toBe(expectedUpstreamId('chat', 'classroom-session-1'));
    expect(second).toBe(first);
    expect(first).toMatch(/^oma_[A-Za-z0-9_-]{43}$/);
  });

  it('separates equal ids in different logical namespaces', () => {
    const values = [
      deriveCodexUpstreamSessionId({ kind: 'chat', id: 'same-id' }),
      deriveCodexUpstreamSessionId({ kind: 'revisit-attempt', id: 'same-id' }),
      deriveCodexUpstreamSessionId({ kind: 'agent-edit', id: 'same-id' }),
      deriveCodexUpstreamSessionId({ kind: 'revisit-artifact', id: 'same-id' }),
    ];

    expect(new Set(values)).toHaveLength(4);
  });

  it('accepts 128 Unicode characters and rejects invalid or over-bound ids safely', () => {
    const maxId = '🙂'.repeat(128);
    expect(deriveCodexUpstreamSessionId({ kind: 'chat', id: maxId })).toBe(
      expectedUpstreamId('chat', maxId),
    );

    const rawSecret = `raw-session-${'🙂'.repeat(129)}`;
    const error = (() => {
      try {
        deriveCodexUpstreamSessionId({ kind: 'chat', id: rawSecret });
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(rawSecret);
    expect(() => deriveCodexUpstreamSessionId({ kind: 'chat', id: '' })).toThrow();
    expect(() =>
      deriveCodexUpstreamSessionId({ kind: 'not-a-kind' as 'chat', id: 'safe-id' }),
    ).toThrow();
  });

  it('does not log raw or derived identities', () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    const rawId = 'private-classroom-session';
    const derived = deriveCodexUpstreamSessionId({ kind: 'chat', id: rawId });

    expect(derived).not.toContain(rawId);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    for (const spy of spies) spy.mockRestore();
  });

  it('creates a fresh ephemeral identity for each missing or invalid external context', () => {
    const first = createEphemeralCodexLogicalSession();
    const second = createEphemeralCodexLogicalSession();
    const missing = parseExternalCodexLogicalSession(undefined);
    const invalid = parseExternalCodexLogicalSession({ kind: 'chat', id: '' });

    expect(deriveCodexUpstreamSessionId(first)).not.toBe(deriveCodexUpstreamSessionId(second));
    expect(deriveCodexUpstreamSessionId(missing)).not.toBe(deriveCodexUpstreamSessionId(invalid));
  });

  it('accepts only external chat and revisit-attempt contexts', () => {
    expect(parseExternalCodexLogicalSession({ kind: 'chat', id: 'chat-1' })).toEqual({
      kind: 'chat',
      id: 'chat-1',
    });
    expect(parseExternalCodexLogicalSession({ kind: 'revisit-attempt', id: 'attempt-1' })).toEqual({
      kind: 'revisit-attempt',
      id: 'attempt-1',
    });

    const internalKind = parseExternalCodexLogicalSession({ kind: 'agent-edit', id: 'editor-1' });
    expect(internalKind.kind).toBe('chat');
    expect(internalKind.id).not.toBe('editor-1');
  });

  it('parses validated internal lifecycle identities without exposing invalid values', () => {
    expect(parseCodexLogicalSession({ kind: 'agent-edit', id: 'editor-1' })).toEqual({
      kind: 'agent-edit',
      id: 'editor-1',
    });
    expect(parseCodexLogicalSession({ kind: 'revisit-artifact', id: 'job-1' })).toEqual({
      kind: 'revisit-artifact',
      id: 'job-1',
    });
    expect(parseCodexLogicalSession({ kind: 'agent-edit', id: '' })).toBeUndefined();
    expect(parseCodexLogicalSession({ kind: 'agent-edit', id: 'x'.repeat(129) })).toBeUndefined();
  });
});
