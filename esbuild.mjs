import * as esbuild from 'esbuild';
const opts = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: !process.argv.includes('--watch'),
  logLevel: 'info',
};
if (process.argv.includes('--watch')) await (await esbuild.context(opts)).watch();
else await esbuild.build(opts);
