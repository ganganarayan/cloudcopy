import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  target: 'node20',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  // Bundle workspace packages (they ship TS sources, not dist)
  noExternal: [/^@cloudcopy\//],
});
