import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

const apiRoot = resolve(process.cwd(), 'app/api');
const publicRoutes = new Set([
  'access-code/status/route.ts',
  'access-code/verify/route.ts',
  'health/route.ts',
]);
const customGuardRoutes = new Map<
  string,
  { module: string; guard: string; methods: readonly string[] }
>([
  [
    'codex/auth/route.ts',
    {
      module: '@/lib/server/codex/route-utils',
      guard: 'requireCodexRouteAccess',
      methods: ['GET', 'DELETE'],
    },
  ],
  [
    'codex/auth/login/route.ts',
    {
      module: '@/lib/server/codex/route-utils',
      guard: 'requireCodexRouteAccess',
      methods: ['POST', 'PATCH', 'DELETE'],
    },
  ],
  // Machine-only preview requests use the gateway signature, independently of
  // browser access cookies. Real signed/unsigned route calls are covered by
  // tests/sandbox/preview-access-code.test.ts.
  ...['resolve', 'tunnel'].map(
    (operation) =>
      [
        `sandbox/preview/${operation}/route.ts`,
        {
          module: '@/lib/server/sandbox/preview',
          guard: 'verifyGatewayRequest',
          methods: ['POST'],
        },
      ] as const,
  ),
]);

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
      const exportedMethods = [
        ...source.matchAll(
          /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g,
        ),
      ].map(([, method]) => method);
      expect(exportedMethods.length, `${route} exports no guarded method`).toBeGreaterThan(0);
      const custom = customGuardRoutes.get(route);
      if (custom) {
        expect(source, route).toContain(`from '${custom.module}'`);
        expect(source, route).toMatch(
          new RegExp(`import\\s*\\{[^}]*\\b${custom.guard}\\b[^}]*\\}\\s*from`),
        );
        expect(exportedMethods.sort(), route).toEqual([...custom.methods].sort());
        expect([...source.matchAll(new RegExp(`\\b${custom.guard}\\(`, 'g'))], route).toHaveLength(
          custom.methods.length,
        );
        continue;
      }
      expect(source, route).toContain('@/lib/server/with-access-code');
      for (const method of exportedMethods) {
        expect(source, `${route} ${method}`).toMatch(
          new RegExp(`export const ${method}\\s*=\\s*withAccessCode\\(`),
        );
      }
    }
  });
});
