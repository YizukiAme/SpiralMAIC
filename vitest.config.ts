import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, '.'),
      // Next resolves this marker to an empty module under the react-server
      // condition. Vitest runs in Node, so mirror only that marker behavior.
      'server-only': resolve(__dirname, 'tests/server-only.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup-env.ts'],
  },
});
