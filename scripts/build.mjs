import { rmSync } from 'fs';
import { build } from 'esbuild';

rmSync('dist', { recursive: true, force: true });

const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
  packages: 'external',
};

await build({
  ...shared,
  entryPoints: ['src/server/index.ts'],
  outfile: 'dist/server/index.js',
});

await build({
  ...shared,
  entryPoints: ['src/cli/index.ts'],
  outfile: 'dist/cli/index.js',
});
