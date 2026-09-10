import { defineConfig } from 'vite';

/**
 * Gate captures are written outside the project, but keep heavy directories out
 * of the dev watcher regardless: a few hundred PNGs under the project root will
 * exhaust the inotify watch limit and take the server down with ENOSPC.
 */
export default defineConfig({
  server: {
    watch: {
      ignored: ['**/screenshots/**', '**/dist/**', '**/.git/**'],
    },
  },
  build: {
    target: 'es2022',
    cssTarget: 'chrome111',
  },
});
