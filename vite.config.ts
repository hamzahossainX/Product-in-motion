import { defineConfig } from 'vite';

/** Vite reads configuration from the environment, and the project deliberately
 *  carries no `@types/node`, so declare the one global that is used. */
declare const process: { env: Record<string, string | undefined> };

/**
 * Where the site is served from.
 *
 * Vercel, Netlify and a custom domain all serve from the root. A GitHub Pages
 * project site serves from `/<repo>/`, and every hashed asset URL has to carry
 * that prefix or the page loads as unstyled HTML with a dead canvas. Rather
 * than hard-code either, take it from the environment and default to root —
 * `.github/workflows/deploy-pages.yml` sets it for the Pages build.
 *
 * Asset URLs built in TypeScript already read `import.meta.env.BASE_URL`, so
 * this one value is enough to relocate the whole site.
 */
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  server: {
    watch: {
      /**
       * Gate captures are written outside the project, but keep heavy
       * directories out of the dev watcher regardless: a few hundred PNGs under
       * the project root will exhaust the inotify watch limit and take the
       * server down with ENOSPC.
       */
      ignored: ['**/screenshots/**', '**/dist/**', '**/.git/**'],
    },
  },
  build: {
    target: 'es2022',
    cssTarget: 'chrome111',
    /**
     * The bundle is one chunk on purpose. Everything in it — renderer, post
     * chain, scenes — is needed before the first frame can be drawn, so
     * splitting it would only add round trips in front of the preloader.
     * Rolldown's default warning compares *uncompressed* bytes against 500 kB;
     * the number that reaches a browser is 208 kB gzipped, against the 400 kB
     * budget that `tools/metrics.mjs` enforces. Raise the threshold to match
     * what is actually shipped so a real regression is still visible.
     */
    chunkSizeWarningLimit: 800,
  },
});
