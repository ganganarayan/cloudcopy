import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
          root: './apps/server',
          environment: 'node',
          include: ['test/**/*.test.ts'],
          testTimeout: 120_000, // embedded-postgres first boot downloads binaries
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
