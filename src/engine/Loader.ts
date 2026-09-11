/**
 * Central asset loader with weighted progress.
 *
 * Progress is weighted by cost, not by task count: a preloader that jumps from
 * 0 to 50% because one of two files is a 2 kB texture is lying, and the Phase 6
 * preloader is meant to show honest progress. Weights are approximate byte
 * costs; procedural work registers the time it actually takes.
 *
 * `autoMobile` swaps in the half-resolution `_MOBILE` variant of a texture path
 * on the mobile tier, so callers never branch on device.
 */
import { NoColorSpace, SRGBColorSpace, Texture, TextureLoader } from 'three';

export interface TextureOptions {
  weight?: number;
  srgb?: boolean;
  /** Load `name_MOBILE.ext` instead when on the mobile tier. */
  autoMobile?: boolean;
}

interface Task {
  name: string;
  weight: number;
  run: () => Promise<void>;
  done: boolean;
}

const DEFAULT_TEXTURE_WEIGHT = 32 * 1024;
const MOBILE_SUFFIX = '_MOBILE';

export class Loader {
  private readonly tasks: Task[] = [];
  private readonly textureLoader = new TextureLoader();
  private completedWeight = 0;
  private readonly mobile: boolean;
  private onProgress: ((progress: number) => void) | null = null;

  constructor(mobile: boolean) {
    this.mobile = mobile;
  }

  get totalWeight(): number {
    return this.tasks.reduce((sum, task) => sum + task.weight, 0);
  }

  /** 0..1, weighted. 1 only once every task has resolved. */
  get progress(): number {
    const total = this.totalWeight;
    return total > 0 ? Math.min(1, this.completedWeight / total) : 1;
  }

  observe(callback: (progress: number) => void): void {
    this.onProgress = callback;
  }

  /** Any unit of startup work — a fetch, a prefilter, a geometry build. */
  add(name: string, weight: number, run: () => void | Promise<void>): void {
    this.tasks.push({
      name,
      weight,
      done: false,
      run: async () => { await run(); },
    });
  }

  /** Registers a texture and returns it immediately; three fills it in. */
  texture(url: string, options: TextureOptions = {}): Texture {
    const resolved = options.autoMobile && this.mobile ? toMobilePath(url) : url;
    const texture = new Texture();
    this.add(resolved, options.weight ?? DEFAULT_TEXTURE_WEIGHT, () =>
      new Promise<void>((resolve, reject) => {
        this.textureLoader.load(resolved, (loaded) => {
          texture.image = loaded.image;
          texture.colorSpace = options.srgb ? SRGBColorSpace : NoColorSpace;
          texture.needsUpdate = true;
          loaded.dispose();
          resolve();
        }, undefined, reject);
      }));
    return texture;
  }

  /** Runs everything, reporting weighted progress as each task lands. */
  async start(): Promise<void> {
    this.completedWeight = 0;
    this.onProgress?.(0);
    await Promise.all(this.tasks.map(async (task) => {
      try {
        await task.run();
      } finally {
        // A failed asset must not stall the preloader at 80% forever; the site
        // is still usable without any one of them.
        task.done = true;
        this.completedWeight += task.weight;
        this.onProgress?.(this.progress);
      }
    }));
    this.onProgress?.(1);
  }
}

/** `/textures/paper.png` -> `/textures/paper_MOBILE.png` */
export function toMobilePath(url: string): string {
  const dot = url.lastIndexOf('.');
  return dot < 0 ? `${url}${MOBILE_SUFFIX}` : `${url.slice(0, dot)}${MOBILE_SUFFIX}${url.slice(dot)}`;
}
