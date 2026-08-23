import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

const apiRoot = resolve(process.cwd(), 'app/api');
const publicRoutes = new Set([
  'access-code/status/route.ts',
  'access-code/verify/route.ts',
  'health/route.ts',
]);
const customGuardRoutes = new Set(['codex/auth/route.ts', 'codex/auth/login/route.ts']);

function routeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) return routeFiles(target);
    return entry.name === 'route.ts' ? [target] : [];
  });
}

describe('API access-code architecture', () => {
  test('guards every non-public route handler at the server boundary', () => {
    for (const file of routeFiles(apiRoot)) {
      const route = relative(apiRoot, file);
      if (publicRoutes.has(route)) continue;

      const source = readFileSync(file, 'utf8');
      if (customGuardRoutes.has(route)) {
        expect(source, route).toContain('requireCodexRouteAccess');
        continue;
      }
      expect(source, route).toContain('@/lib/server/with-access-code');
      const exportedMethods = [...source.matchAll(/export const (GET|POST|PUT|PATCH|DELETE)/g)];
      expect(exportedMethods.length, `${route} exports no guarded method`).toBeGreaterThan(0);
      for (const [, method] of exportedMethods) {
        expect(source, `${route} ${method}`).toMatch(
          new RegExp(`export const ${method}\\s*=\\s*withAccessCode\\(`),
        );
      }
    }
  });
});
