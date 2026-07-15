import { createHash, randomUUID } from 'node:crypto';

export const CODEX_LOGICAL_SESSION_KINDS = [
  'chat',
  'revisit-attempt',
  'agent-edit',
  'revisit-artifact',
] as const;

export type CodexLogicalSessionKind = (typeof CODEX_LOGICAL_SESSION_KINDS)[number];

export interface CodexLogicalSession {
  kind: CodexLogicalSessionKind;
  id: string;
}

export type CodexUpstreamSessionId = `oma_${string}`;

const EXTERNAL_SESSION_KINDS = new Set<CodexLogicalSessionKind>(['chat', 'revisit-attempt']);
const SESSION_KINDS = new Set<string>(CODEX_LOGICAL_SESSION_KINDS);
const MAX_SESSION_ID_CHARACTERS = 128;
const HASH_NAMESPACE = 'openmaic-codex-session-v1';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function hasValidId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.trim().length > 0 &&
    isWellFormedUnicode(id) &&
    Array.from(id).length <= MAX_SESSION_ID_CHARACTERS
  );
}

function isLogicalSession(value: unknown): value is CodexLogicalSession {
  return (
    isRecord(value) &&
    typeof value.kind === 'string' &&
    SESSION_KINDS.has(value.kind) &&
    hasValidId(value.id)
  );
}

export function deriveCodexUpstreamSessionId(session: CodexLogicalSession): CodexUpstreamSessionId {
  if (!isLogicalSession(session)) throw new Error('Invalid Codex logical session');
  const digest = createHash('sha256')
    .update(`${HASH_NAMESPACE}\0${session.kind}\0${session.id}`, 'utf8')
    .digest('base64url');
  return `oma_${digest}`;
}

export function createEphemeralCodexLogicalSession(): CodexLogicalSession {
  return { kind: 'chat', id: randomUUID() };
}

export function parseCodexLogicalSession(value: unknown): CodexLogicalSession | undefined {
  return isLogicalSession(value) ? { kind: value.kind, id: value.id } : undefined;
}

export function parseExternalCodexLogicalSession(value: unknown): CodexLogicalSession {
  const session = parseCodexLogicalSession(value);
  if (session && EXTERNAL_SESSION_KINDS.has(session.kind)) {
    return session;
  }
  return createEphemeralCodexLogicalSession();
}
