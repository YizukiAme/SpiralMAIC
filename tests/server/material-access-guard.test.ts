import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { GET as listMaterials, POST as uploadMaterial } from '@/app/api/materials/route';
import {
  GET as readMaterial,
  PATCH as renameMaterial,
  DELETE as deleteMaterial,
} from '@/app/api/materials/[id]/route';
import { GET as originalMaterial } from '@/app/api/materials/[id]/original/route';
import { POST as extractMaterial } from '@/app/api/materials/[id]/extraction/route';
import { GET as listLibrary } from '@/app/api/materials/library/route';
import { GET as listFolders, POST as createFolder } from '@/app/api/materials/folders/route';
import {
  PATCH as renameFolder,
  DELETE as deleteFolder,
} from '@/app/api/materials/folders/[id]/route';
import { POST as moveMaterials } from '@/app/api/materials/move/route';
import { ACCESS_TOKEN_MAX_AGE_MS, createAccessToken } from '@/lib/server/access-token';

type Handler = (
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) => Response | Promise<Response>;

const endpoints: { method: string; path: string; handler: Handler }[] = [
  { method: 'GET', path: '', handler: listMaterials },
  { method: 'POST', path: '', handler: uploadMaterial },
  { method: 'GET', path: '/mat_missing', handler: readMaterial },
  { method: 'PATCH', path: '/mat_missing', handler: renameMaterial },
  { method: 'DELETE', path: '/mat_missing', handler: deleteMaterial },
  { method: 'GET', path: '/mat_missing/original', handler: originalMaterial },
  { method: 'POST', path: '/mat_missing/extraction', handler: extractMaterial },
  { method: 'GET', path: '/library', handler: listLibrary },
  { method: 'GET', path: '/folders', handler: listFolders },
  { method: 'POST', path: '/folders', handler: createFolder },
  { method: 'PATCH', path: '/folders/folder_missing', handler: renameFolder },
  { method: 'DELETE', path: '/folders/folder_missing', handler: deleteFolder },
  { method: 'POST', path: '/move', handler: moveMaterials },
];

const accessCode = 'material-library-test-code';

function call(endpoint: (typeof endpoints)[number], cookie?: string) {
  return endpoint.handler(
    new NextRequest(`http://localhost/api/materials${endpoint.path}`, {
      method: endpoint.method,
      ...(cookie ? { headers: { cookie: `openmaic_access=${cookie}` } } : {}),
    }),
    { params: Promise.resolve({ id: 'mat_missing' }) },
  );
}

describe('material routes retain the deployment access-code boundary', () => {
  beforeEach(() => {
    vi.stubEnv('ACCESS_CODE', accessCode);
    // An unguarded route returns 404 here. Access must be checked first,
    // before database availability, body parsing, or minting an owner cookie.
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'false');
  });

  afterEach(() => vi.unstubAllEnvs());

  for (const endpoint of endpoints) {
    describe(`${endpoint.method} /api/materials${endpoint.path}`, () => {
      it.each(['missing', 'invalid', 'expired'] as const)('refuses a %s cookie', async (kind) => {
        const token =
          kind === 'missing'
            ? undefined
            : kind === 'invalid'
              ? 'invalid'
              : createAccessToken(accessCode, Date.now() - ACCESS_TOKEN_MAX_AGE_MS - 1000);
        const response = await call(endpoint, token);
        expect(response.status).toBe(401);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.has('set-cookie')).toBe(false);
        expect(await response.json()).toMatchObject({ error: 'Access code required' });
      });

      it('lets a signed cookie reach the existing persistence gate', async () => {
        expect((await call(endpoint, createAccessToken(accessCode))).status).toBe(404);
      });

      it('does not require a cookie when access-code protection is disabled', async () => {
        vi.stubEnv('ACCESS_CODE', '');
        expect((await call(endpoint)).status).toBe(404);
      });
    });
  }
});
