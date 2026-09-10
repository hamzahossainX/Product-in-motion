/**
 * Phase 1 entry point.
 *
 * The only JS this phase permits: keep `--vh` in sync with the real viewport
 * height so `--screen-unit` stays correct when mobile browser chrome collapses.
 * No animation, no scroll engine, no canvas — those arrive in Phases 2 and 3.
 */
import './styles/tokens.css';
import './styles/base.css';
import './styles/sections/index.css';

const VH_PROPERTY = '--vh';

function setViewportUnit(): void {
  document.documentElement.style.setProperty(
    VH_PROPERTY,
    `${window.innerHeight / 100}px`,
  );
}

setViewportUnit();
window.addEventListener('resize', setViewportUnit, { passive: true });
window.addEventListener('orientationchange', setViewportUnit, { passive: true });
