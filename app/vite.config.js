import {defineConfig} from 'vite';
import {readFileSync} from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  // relative paths: works in the iOS / Android apps and under any web path
  base: './',
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
  },
  worker: {format: 'es'},
  build: {
    target: ['es2020', 'safari15'],
    outDir: 'dist',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
  },
  server: {host: true, port: 5173},
  preview: {host: true, port: 4173},
  test: {
    include: ['test/**/*.test.js'],
    testTimeout: 60000,
  },
});
