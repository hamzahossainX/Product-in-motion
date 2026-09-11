# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) —
loosely, since this is a website rather than a library. A major bump means the
page changed in a way a returning visitor would notice.

## [1.0.0] — 2026-09-11

First public release. Eight sections, one canvas, three runtime dependencies.

### Added

**Engine**
- One renderer for the whole site, with a hard DPR clamp at 1.5 and a total
  pixel budget that scales the ratio down until `w × h × dpr²` fits 2560×1440.
- Reset-then-claim frame loop. Sections write partial, scroll-weighted claims
  over wiped defaults, so overlapping sections cross-fade instead of cutting.
- DOM-driven 3D placement: six sections carry an anchor box positioned by CSS,
  and the object is placed into whatever part of the grid the copy leaves free.
- Camera rig with a bake seam — `BakedCameraPath` loads a JSON keyframe file if
  one is present and falls back to the code path if not.
- Weighted loader, so the preloader reports work done rather than files counted.

**Post-processing chain** — hand-written, no library
- TAA with Halton jitter, depth reprojection and a YCoCg neighbourhood clamp.
- FXAA.
- Physically-modelled thin-lens bokeh — a real circle of confusion, so pulling
  focus moves a plane through the scene instead of fading a blur in and out.
- Multi-mip bloom with separate down and up chains.
- Final grade: ACES tonemapping written by hand inside the grade, vignette,
  blue-noise dither and sRGB encode.

**Generated assets** — the only binaries in the repository are two fonts, a
16 kB blue-noise tile and the social image
- Void-and-cluster blue noise.
- Prefiltered PMREM environment, built at runtime.
- Procedural vinyl material maps, graphite dust, and the light cookie.
- The eraser geometry itself, including a provably fold-free worn edge built
  from a softplus half-space clip with a rank-one normal update.

**Interactions**
- Unlearning: type a sentence, watch it render as graphite on paper, drag the
  eraser across it and have it physically removed. Text is rasterised to a
  signed distance field in a Web Worker.
- Abrasion: a draggable magnifier that genuinely re-renders the region.
- Hardness: a slider blending two colour grades and the material response.
- Configurator: three variants on a separate camera path.

**Verification**
- Six gate harnesses driving Chrome over the DevTools Protocol and Firefox over
  WebDriver BiDi, using Node built-ins only. They measure against controls
  rather than asserting: banding against the same frame with the dither off,
  bokeh against the lens closed, allocation against the loop stopped.

**Accessibility**
- Full keyboard path through every control, visible focus rings sized from
  `--screen-unit`, and a `prefers-reduced-motion` mode that stops everything
  self-animating while keeping the page rendered.

### Performance

60 fps sustained on an AMD Radeon Vega 10, idle and scrolling, with 18 draw
calls against an 80 budget. 208 kB of gzipped JavaScript against a 400 kB
budget. FCP and LCP both 0.18 s, CLS 0.

### Known limitations

- Safari, iOS Safari and Android Chrome are untested — there was no Safari and
  no device on the machine this was built on. Chrome and Firefox are verified.
- Lighting is three runtime lights plus a generated environment map; a Blender
  lightmap bake would be cheaper and better.
- Live text uses a single-channel signed distance field rather than MSDF, which
  would need a font parser and a fourth runtime dependency.

[1.0.0]: https://github.com/hamzahossainX/Product-in-motion/releases/tag/v1.0.0
