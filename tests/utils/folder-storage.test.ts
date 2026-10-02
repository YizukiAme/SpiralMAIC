import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Exercise the browser folder API through the real route handlers. The owner
 * store is in memory, while document deletion's unrelated runtime cascade is
 * mocked so the two delete modes remain observable without a database.
 */
const { folders, memberships, folderStore, mutateDocumentMock, deleteDocumentMock } = vi.hoisted(
  () => {
    type Folder = { id: string; name: string; order: number; createdAt: number; updatedAt: number };
    const folders = new Map<string, Folder>();
    const memberships = new Map<string, string>();
    const deleteDocumentMock = vi.fn(async (_stageId: string) => {});
    const mutateDocumentMock = vi.fn();

    const folderStore = {
      async listFolders() {
        return [...folders.values()].sort((a, b) => a.order - b.order);
      },
      async createFolder(id: string, name: string) {
        const folder = { id, name, order: folders.size, createdAt: 1, updatedAt: 1 };
        folders.set(id, folder);
        return { folder, reused: false };
      },
      async renameFolder(id: string, name: string) {
        const current = folders.get(id);
        if (!current) return null;
        const folder = { ...current, name, updatedAt: 2 };
        folders.set(id, folder);
        return folder;
      },
      async deleteFolder(id: string, mode: 'ungroup' | 'remove') {
        if (!folders.delete(id)) return null;
        const members = [...memberships]
          .filter(([, folderId]) => folderId === id)
          .map(([stageId]) => stageId);
        for (const stageId of members) memberships.delete(stageId);
        return { removedStageIds: mode === 'remove' ? members : [] };
      },
      async setStageFolder(stageId: string, folderId: string | null) {
        if (folderId && !folders.has(folderId)) return false;
        if (folderId) memberships.set(stageId, folderId);
        else memberships.delete(stageId);
        return true;
      },
    };
    return { folders, memberships, folderStore, mutateDocumentMock, deleteDocumentMock };
  },
);

vi.mock('@/lib/server/agent-runtime/owner-scoped-documents', () => ({
  getOwnerScopedDocumentStore: vi.fn(async () => folderStore),
}));
vi.mock('@/lib/server/identity/with-owner', () => ({
  withRequestOwner: vi.fn(
    async (
      _request: Request,
      handler: (owner: { ownerId: string }, headers: Headers) => Promise<Response>,
    ) => handler({ ownerId: 'owner-1' }, new Headers()),
  ),
}));
vi.mock('@/lib/device-storage/database', () => ({ db: {} }));
vi.mock('@/lib/document-store', () => ({
  accessDocument: vi.fn(),
  clearCurrentScene: vi.fn().mockResolvedValue(undefined),
  getDocumentStore: vi.fn(),
  loadCurrentScene: vi.fn().mockResolvedValue(null),
  mutateDocument: mutateDocumentMock,
  saveCurrentScene: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/media/clear-stage-media-cache', () => ({
  clearStageMediaCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/utils/chat-storage', () => ({
  ChatStorageLockUnavailableError: class extends Error {},
  saveChatSessions: vi.fn().mockResolvedValue(undefined),
  loadChatSessions: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/utils/chat-storage-lock', () => ({
  withRuntimeStorageSharedLock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withRuntimeStorageExclusiveLockUntilSettled: vi.fn(
    async (fn: (release: (value?: unknown) => void) => Promise<unknown>) => fn(() => {}),
  ),
}));
vi.mock('@/lib/playback/cursor', () => ({ clearCursor: vi.fn() }));
vi.mock('@/lib/quiz/persistence', () => ({ clearAllForScene: vi.fn() }));
vi.mock('@/lib/runtime/store', () => ({
  beginStageRuntimeDeletionSafely: vi.fn(() => ({
    completion: Promise.resolve(),
    settlement: Promise.resolve(),
  })),
}));
vi.mock('@/lib/pbl/v2/runtime/drain', () => ({ clearStageDrainWatermarks: vi.fn() }));
vi.mock('@/lib/store/stage', () => ({
  clearStoreForDeletedStage: vi.fn(),
  discardPendingStageChanges: vi.fn(),
  snapshotPendingStageChangesForDeletion: vi.fn().mockReturnValue([]),
  restorePendingStageChanges: vi.fn(),
}));
vi.mock('@/lib/pbl/v2/runtime/document-persistence', () => ({
  preparePBLScenesForDocumentPersistence: vi.fn(async (_id: string, scenes: unknown[]) => scenes),
}));

import { GET as listRoute, POST as createRoute } from '@/app/api/folders/route';
import { PATCH as renameRoute, DELETE as deleteRoute } from '@/app/api/folders/[id]/route';
import { POST as membershipRoute } from '@/app/api/folders/members/route';
import {
  createFolder,
  deleteFolder,
  FolderNameError,
  listFolders,
  renameFolder,
  setStageFolder,
} from '@/lib/utils/stage-storage';

async function routeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), 'http://localhost');
  const request = new NextRequest(url, {
    method: init?.method,
    headers: init?.headers,
    body: init?.body,
  });
  if (url.pathname === '/api/folders') {
    if (request.method === 'GET') return listRoute(request);
    if (request.method === 'POST') return createRoute(request);
  }
  if (url.pathname === '/api/folders/members' && request.method === 'POST') {
    return membershipRoute(request);
  }
  const match = /^\/api\/folders\/([^/]+)$/.exec(url.pathname);
  if (match) {
    const context = { params: Promise.resolve({ id: decodeURIComponent(match[1]) }) };
    if (request.method === 'PATCH') return renameRoute(request, context);
    if (request.method === 'DELETE') return deleteRoute(request, context);
  }
  throw new Error(`Unexpected folder request: ${request.method} ${url.pathname}`);
}

beforeEach(() => {
  vi.stubEnv('DATABASE_URL', 'postgres://folder-test');
  vi.stubEnv('ACCESS_CODE', '');
  vi.stubGlobal('fetch', vi.fn(routeFetch));
  folders.clear();
  memberships.clear();
  deleteDocumentMock.mockClear();
  mutateDocumentMock
    .mockReset()
    .mockImplementation(
      async (
        stageId: string,
        action: (
          document: undefined,
          store: { deleteDocument: typeof deleteDocumentMock },
        ) => Promise<void>,
      ) => action(undefined, { deleteDocument: deleteDocumentMock }),
    );
});

describe('createFolder / renameFolder name validation', () => {
  it('maps an empty-name refusal to FolderNameError', async () => {
    await expect(createFolder('   ')).rejects.toMatchObject({ kind: 'empty' });
  });

  it('maps an over-width refusal, including full-width characters', async () => {
    await expect(createFolder('a'.repeat(41))).rejects.toMatchObject({ kind: 'tooLong' });
    await expect(createFolder('中'.repeat(21))).rejects.toMatchObject({ kind: 'tooLong' });
  });

  it('rejects a case-insensitive duplicate', async () => {
    await createFolder('Math');
    await expect(createFolder('math')).rejects.toMatchObject({ kind: 'duplicate' });
  });

  it('trims the stored name and lists only the client folder shape', async () => {
    const folder = await createFolder('  Physics  ');
    expect(folder.name).toBe('Physics');
    expect(await listFolders()).toEqual([folder]);
    expect(folder).not.toHaveProperty('userKey');
  });

  it('rejects an empty name on rename', async () => {
    const folder = await createFolder('Old');
    await expect(renameFolder(folder.id, '  ')).rejects.toMatchObject({ kind: 'empty' });
  });

  it('rejects a duplicate rename but allows keeping the current name', async () => {
    const alpha = await createFolder('Alpha');
    await createFolder('Beta');
    await expect(renameFolder(alpha.id, 'beta')).rejects.toMatchObject({ kind: 'duplicate' });
    await expect(renameFolder(alpha.id, 'Alpha')).resolves.toBeUndefined();
    expect(folders.get(alpha.id)?.name).toBe('Alpha');
  });

  it('maps the server folder-count limit to FolderNameError', async () => {
    for (let index = 0; index < 50; index += 1) {
      await createFolder(`Folder ${index}`);
    }
    await expect(createFolder('One too many')).rejects.toMatchObject({ kind: 'limit' });
  });
});

describe('setStageFolder membership', () => {
  it('files a stage in an existing folder', async () => {
    const folder = await createFolder('Dest');
    await setStageFolder('stage-1', folder.id);
    expect(memberships.get('stage-1')).toBe(folder.id);
  });

  it('maps a missing-folder refusal to the client error', async () => {
    await expect(setStageFolder('stage-1', 'missing')).rejects.toThrow('Folder not found: missing');
    expect(memberships.has('stage-1')).toBe(false);
  });

  it('unfiles by removing the membership, idempotently', async () => {
    const folder = await createFolder('Dest');
    await setStageFolder('stage-1', folder.id);
    await setStageFolder('stage-1', undefined);
    await setStageFolder('stage-1', undefined);
    expect(memberships.has('stage-1')).toBe(false);
  });
});

describe('deleteFolder', () => {
  it("'ungroup' drops the folder and membership without deleting stages", async () => {
    const folder = await createFolder('Group A');
    await setStageFolder('ungroup-1', folder.id);
    await setStageFolder('ungroup-2', folder.id);

    await deleteFolder(folder.id, 'ungroup');

    expect(folders.has(folder.id)).toBe(false);
    expect(memberships.has('ungroup-1')).toBe(false);
    expect(memberships.has('ungroup-2')).toBe(false);
    expect(deleteDocumentMock).not.toHaveBeenCalled();
  });

  it("'remove' deletes captured members through the document cascade", async () => {
    const folder = await createFolder('Group B');
    await setStageFolder('remove-1', folder.id);
    await setStageFolder('remove-2', folder.id);

    await deleteFolder(folder.id, 'remove');

    expect(folders.has(folder.id)).toBe(false);
    expect(memberships.has('remove-1')).toBe(false);
    expect(memberships.has('remove-2')).toBe(false);
    expect(deleteDocumentMock.mock.calls.map(([id]) => id).sort()).toEqual([
      'remove-1',
      'remove-2',
    ]);
  });

  it("'remove' surfaces a member-deletion failure after the folder was removed", async () => {
    const folder = await createFolder('Group C');
    await setStageFolder('failed-remove', folder.id);
    mutateDocumentMock.mockRejectedValueOnce(new Error('boom'));

    await expect(deleteFolder(folder.id, 'remove')).rejects.toThrow('boom');
    expect(folders.has(folder.id)).toBe(false);
    expect(memberships.has('failed-remove')).toBe(false);
    expect(deleteDocumentMock).not.toHaveBeenCalled();
  });
});

describe('FolderNameError', () => {
  it('carries a machine-readable kind', () => {
    const error: FolderNameError = new FolderNameError('msg', 'duplicate');
    expect(error.kind).toBe('duplicate');
    expect(error).toBeInstanceOf(Error);
  });
});
