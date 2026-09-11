# ERASER-1

A one-page site for a rectangular vinyl eraser, marketed with total sincerity
as an open-weight AI model. Its headline capability is **unlearning**. It has
one parameter, a context window of one page, an inference cost of 0 W, and zero
data retention — physically enforced.

The joke is never winked at. The register is a product launch: spec tables, a
benchmark, a preprint with an abstract and a BibTeX block, and a peer review
quote. The tension it runs on is that the industry is spending billions on a
problem a 40¢ object solved in 1770.

## Running it

```bash
npm install
npm run dev          # vite dev server
npm run typecheck    # tsc --noEmit
npm run build        # typecheck, then production build
npm run preview -- --port 5178
```

`?debug=1` mounts a live GUI for every colour-grade parameter plus a stats panel
(fps, frame time, draw calls, triangles). `?probe=1` exposes the same handle
with no panels, which is what the harnesses drive — a frame-loop measurement
taken with the debug overlay running measures the overlay.

## How it is built

Vite, TypeScript in strict mode, and three dependencies: **three**, **lenis**,
**gsap**. No render framework, no post-processing library, no UI kit.

A few decisions carry most of it:

- **One canvas, one renderer, one post chain.** Sections never mount their own.
- **Reset-then-claim.** Every frame wipes the grade, the gobo, the hero's
  transform and the writing sheet, then each section blends a *partial weighted
  claim* over the defaults. Nothing writes an absolute value. That is why two
  sections visible at once cross-fade instead of one cutting to the other, and
  why the scroll reads as a single camera move rather than nine slides.
- **The DOM drives the 3D.** Six sections carry an empty anchor box positioned
  by CSS; the object is placed inside whichever part of that section's grid the
  copy leaves free. A hard-coded world position that clears the text at 1920
  sits on top of it at 1024.
- **Springs, not lerps.** Every smoothed value is a second-order system.
- **A fluid `--screen-unit`.** `min()` of a width-derived and a height-derived
  unit, so the composition survives a short laptop screen.

The post chain is scene → TAA → FXAA → bokeh → bloom → grade, with hand-written
ACES and a blue-noise dither on the final output. The bokeh is a real thin-lens
circle of confusion, so pulling focus moves a plane through the scene rather
than fading a blur in and out. The eraser, its materials, the environment map,
the graphite dust and the light cookie are all generated in code — the only
binaries in the repo are the fonts, a 16 kB blue-noise tile and the social
image.

## Verifying it

Each build phase has a harness that measures the result rather than asserting
it. They drive headless Chrome over the DevTools Protocol and Firefox over
WebDriver BiDi, using Node built-ins only.

```bash
npm run preview -- --port 5178   # in one shell
node tools/gate3.mjs             # renderer, post chain, banding, grade
node tools/gate4.mjs             # hero, gobo, particles, allocation
node tools/gate5.mjs             # camera continuity, weighted claims
node tools/gate6.mjs             # text reveals, flippers, preloader, cursor
node tools/gate7.mjs             # the four interactions
node tools/gate8.mjs             # mobile tier, accessibility, budgets
node tools/perf.mjs              # frame times on the real GPU
node tools/metrics.mjs           # FCP, LCP, TBT, CLS
node tools/firefox.mjs           # the same page in Gecko
```

They check things like: that the background gradient's banding disappears
*because of* the dither (by rendering the same frame without it), that bokeh's
sharpness peaks at the object's own distance, that two sections are claiming at
once at most scroll positions, that scrubbing backwards lands within 0.000 px
of scrubbing forwards, and that the magnifier changes 93.8% of the pixels
inside its lens and 0.0% outside.

Gate captures are written to `screenshots/`, which is intentionally not tracked.

## Where things stand

60 fps sustained on an AMD Radeon Vega 10, idle and scrolling, with 21 draw
calls of an 80 budget; 19 calls and the same frame time on a 390×844 mobile
tier. FCP 0.18 s, LCP 0.18 s, CLS 0. 208 kB of gzipped JavaScript against a
400 kB budget.

Known and deliberate:

- Safari, iOS Safari and Android Chrome are **untested** — there is no Safari
  and no device on the machine this was built on. Chrome and Firefox are
  verified.
- The camera path is code keyframes. `BakedCameraPath` is wired and waiting for
  an artist-keyframed bake; dropping a JSON file into `public/models` is the
  whole integration.
- Lighting is three runtime lights plus a generated environment map. A Blender
  lightmap bake would be cheaper and better.
- The live text is a single-channel signed distance field rather than MSDF,
  which would need a font parser and a sixth dependency.

## Documents

| | |
|---|---|
| `CONCEPT.md` | The locked creative brief — product, palette, copy, sections |
| `SPEC.md` | DOM ids, section map, per-section claims, phase checklist |
| `CLAUDE.md` | 23 non-negotiables the implementation is held to |
| `DECISIONS.md` | Every judgement call made without stopping to ask, with why |
| `PROGRESS.md` | What each phase built, and the measurements that closed it |
