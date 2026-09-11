## What this changes

<!-- One paragraph. What moved, and why. -->

## How it was verified

<!-- Measurements, not adjectives. Which gate, which number, before and after.
     "Looks smoother" is not a result; "frame time 12.1 ms -> 9.4 ms over 600
     frames" is. Screenshots for anything visual. -->

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run build` passes
- [ ] `npm run gates` passes, or the affected gate is named above with its output
- [ ] No new runtime dependency
- [ ] No file crosses 300 lines
- [ ] No allocation added to the frame loop
- [ ] Every new constant is named at the top of its file
- [ ] Every smoothed value uses a spring, not a lerp
- [ ] Scroll-linked motion reads a `ScrollRange.ratio` through `fit()`
