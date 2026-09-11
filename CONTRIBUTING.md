# Contributing

Thanks for looking. This is a portfolio piece with an unusually strict rulebook,
so it is worth knowing what the rules are before you spend an evening on a patch.

## Getting set up

```bash
git clone https://github.com/hamzahossainX/Product-in-motion.git
cd Product-in-motion
npm ci
npm run dev
```

Node 22 (see [`.nvmrc`](.nvmrc)). Nothing else to install — the gate harnesses
drive Chrome and Firefox through their own protocols using Node built-ins, so
there is no Playwright or Puppeteer to pull down.

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | typecheck, then production build |
| `npm run preview` | serve the production build |
| `npm run gates` | build, serve, and run every gate harness |
| `npm run gates -- 5 7` | run only those gates |

## The rules

There are twenty-three of them and they are not suggestions — they are the
reason the site holds together. They live in the README under
**[Engineering rules](README.md#engineering-rules)**. The ones that bite hardest
in review:

**Reset-then-claim.** Every frame wipes the grade, the lighting, the hero
transform and the writing sheet, and then each section blends a *partial*,
scroll-weighted claim over the defaults. Nothing writes an absolute value. If
you set something directly, two sections visible at once will fight, and the
scroll will cut instead of cross-fading. This is the single easiest rule to
break by accident.

**The DOM drives the 3D, never the reverse.** HTML lays out normally; the 3D
reads element rects. A world position hard-coded to clear the copy at 1920 sits
on top of it at 1024.

**Springs, not lerps.** Every smoothed value is a `SecondOrderDynamics`. A lerp
with a per-frame factor is frame-rate dependent and reads as mush.

**No allocation in the frame loop.** Pre-allocate every `Vector3`, `Quaternion`
and `Matrix4` at module scope. Gate 4 measures this against a control with the
loop stopped, so a `new` in an update path will be caught.

**No file over 300 lines.** Split the scene instead.

**No new runtime dependency.** Three is the budget: `three`, `lenis`, `gsap`.
Open an issue before writing code that needs a fourth.

## Verifying a change

Adjectives are not evidence. Every phase of this build closed on a measurement,
and a pull request is held to the same bar: name the number, before and after.

```bash
npm run gates          # all of them
npm run gates -- 3     # just the renderer and post chain
```

The harnesses measure against controls rather than asserting — banding is
compared against the same frame with the dither switched off, bokeh against the
lens closed, allocation against the loop stopped. If you add a check, add its
control too.

Two notes on running them:

- **They need a real GPU.** Gate 3 launches Chrome with hardware rendering on
  purpose: a six-pass chain under SwiftShader takes seconds a frame. This is why
  CI runs typecheck, build and the bundle budget but *not* the gates — GitHub's
  runners have no GPU, and a gate that silently measures software rendering is
  worse than no gate.
- **Gate captures** land in `screenshots/`, which is deliberately untracked.

## Style

Match the file you are editing. Beyond that:

- Comments explain *why*, not what. The codebase is full of comments recording a
  decision and the thing that forced it — that is the house style, and it is the
  most valuable part of the repository. If you fixed something subtle, write
  down what bit you.
- Every magic number is a named constant at the top of its file, with a comment
  if the value is not self-evident.
- TypeScript strict, no `any`. `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes` are on; work with them rather than casting past
  them.
- Shared uniforms are passed by reference through the `sharedUniforms` object,
  never copied per frame.

## Commits

Subject lines are lower-case, scoped, and describe the change rather than the
file:

```
post: multi-mip bloom
scenes: the eraser, built rather than loaded
engine: one renderer, with a DPR clamp and a pixel budget
```

Bodies are welcome and encouraged — say what forced the decision. Keep each
commit to one coherent change that typechecks on its own.

## Code of conduct

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
