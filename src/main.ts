/**
 * Entry point.
 *
 * Keeps `--vh` in sync with the real viewport height so `--screen-unit` stays
 * correct when mobile browser chrome collapses, then hands off to the single
 * frame loop in App.
 */
import './styles/tokens.css';
import './styles/base.css';
import './styles/sections/index.css';
import './styles/engine.css';
import './styles/dom-motion.css';
import { App } from './engine/App.ts';

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

const app = new App();
app.start();

if (import.meta.hot) {
  import.meta.hot.dispose(() => app.destroy());
}
