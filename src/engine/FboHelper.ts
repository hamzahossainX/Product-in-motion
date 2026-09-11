/**
 * Render-target plumbing for the post chain.
 *
 * Everything downstream draws a single fullscreen TRIANGLE, not a quad. A quad
 * splits the screen across a diagonal seam where the two triangles meet, which
 * costs an extra vertex batch and breaks quad-level derivative coherence along
 * the seam. One oversized triangle clipped to the viewport has neither problem.
 */
import {
  BufferGeometry, Camera, Float32BufferAttribute, HalfFloatType, LinearFilter,
  Material, Mesh, NoColorSpace, RGBAFormat, Scene, ShaderMaterial, Texture,
  WebGLRenderTarget, WebGLRenderer, ClampToEdgeWrapping, NearestFilter, NoBlending,
} from 'three';
import type { TextureDataType } from 'three';

/** Vertices at (-1,-1) (3,-1) (-1,3): covers the clip cube, clipped to viewport. */
const TRIANGLE_POSITIONS = [-1, -1, 0, 3, -1, 0, -1, 3, 0];
const TRIANGLE_UVS = [0, 0, 2, 0, 0, 2];

// `position` and `uv` are declared by three's ShaderMaterial prefix; declaring
// them again is a compile error, not a redundancy.
export const FULLSCREEN_VERTEX_SHADER = /* glsl */ `
varying vec2 v_uv;
void main() {
  v_uv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export interface RenderTargetOptions {
  depthBuffer?: boolean;
  /** Half float unless a pass genuinely only needs 8 bits. */
  type?: TextureDataType;
  /** Nearest only where interpolation would invent values that are not in the
   *  source, such as depth or the blue-noise tile. */
  filter?: typeof LinearFilter | typeof NearestFilter;
}

let geometry: BufferGeometry | null = null;
let mesh: Mesh | null = null;
let scene: Scene | null = null;
let camera: Camera | null = null;

function ensureTriangle(): { mesh: Mesh; scene: Scene; camera: Camera } {
  if (!mesh || !scene || !camera) {
    geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(TRIANGLE_POSITIONS, 3));
    geometry.setAttribute('uv', new Float32BufferAttribute(TRIANGLE_UVS, 2));
    mesh = new Mesh(geometry);
    mesh.frustumCulled = false;
    scene = new Scene();
    scene.add(mesh);
    // The vertex shader ignores every matrix, so the camera is only a required
    // argument, never a transform.
    camera = new Camera();
  }
  return { mesh, scene, camera };
}

export function createRenderTarget(
  width: number,
  height: number,
  options: RenderTargetOptions = {},
): WebGLRenderTarget {
  const filter = options.filter ?? LinearFilter;
  const target = new WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
    format: RGBAFormat,
    type: options.type ?? HalfFloatType,
    minFilter: filter,
    magFilter: filter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    depthBuffer: options.depthBuffer ?? false,
    stencilBuffer: false,
    generateMipmaps: false,
    colorSpace: NoColorSpace,
  });
  target.texture.name = 'post';
  return target;
}

/**
 * Draw `material` over `target` (or the canvas when target is null).
 *
 * This goes through `renderer.render` even though it draws one triangle whose
 * vertex shader ignores every matrix involved. `renderBufferDirect` would skip
 * the render list, the scene walk and the light resolution, and it is where the
 * loop's remaining ~800 bytes of per-frame garbage comes from — but in three
 * 0.185 it reads `currentRenderState`, which only `render()` establishes, so
 * calling it standalone throws. The garbage is transient and retains nothing;
 * see PROGRESS.md for the measurement.
 */
export function blit(
  renderer: WebGLRenderer,
  material: Material,
  target: WebGLRenderTarget | null,
): void {
  const triangle = ensureTriangle();
  triangle.mesh.material = material;
  renderer.setRenderTarget(target);
  renderer.render(triangle.scene, triangle.camera);
}

/** A pair of same-size targets a chain of passes can bounce between. */
export class PingPong {
  private a: WebGLRenderTarget;
  private b: WebGLRenderTarget;

  constructor(width: number, height: number, options?: RenderTargetOptions) {
    this.a = createRenderTarget(width, height, options);
    this.b = createRenderTarget(width, height, options);
  }

  get read(): WebGLRenderTarget { return this.a; }
  get write(): WebGLRenderTarget { return this.b; }
  get texture(): Texture { return this.a.texture; }

  swap(): void {
    const t = this.a;
    this.a = this.b;
    this.b = t;
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    this.a.setSize(w, h);
    this.b.setSize(w, h);
  }

  dispose(): void {
    this.a.dispose();
    this.b.dispose();
  }
}

export function createPassMaterial(
  fragmentShader: string,
  uniforms: ShaderMaterial['uniforms'],
): ShaderMaterial {
  return new ShaderMaterial({
    uniforms,
    vertexShader: FULLSCREEN_VERTEX_SHADER,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
    transparent: false,
    // Not an optimisation — a correctness requirement. three's default is
    // NormalBlending, which blends src against dst weighted by src alpha. The
    // bokeh pass carries the circle of confusion in alpha, where a value of 6
    // means six pixels, not six times opaque; blending it multiplies the colour
    // by that and subtracts the destination. Every pass here overwrites.
    blending: NoBlending,
  });
}

export function disposeTriangle(): void {
  geometry?.dispose();
  geometry = null;
  mesh = null;
  scene = null;
  camera = null;
}
