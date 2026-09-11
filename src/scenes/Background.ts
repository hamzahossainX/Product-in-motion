/**
 * The background gradient.
 *
 * A fullscreen shader quad, not a CSS gradient behind the canvas: it has to be
 * inside the render so bloom, bokeh and the grade all act on it.
 *
 * The two stops are mixed in sRGB space and dithered there before being decoded
 * to linear. Mixing in sRGB is what a designer picking two hex values expects,
 * and dithering before the decode puts the noise exactly where the eventual
 * 8-bit quantisation will be — which is the whole reason this gradient does not
 * band across two thirds of the viewport.
 */
import {
  BufferGeometry, Color, Float32BufferAttribute, Mesh, NoBlending, ShaderMaterial,
  Uniform, Vector2,
} from 'three';
import type { BlueNoise } from '../engine/BlueNoise.ts';
import { BLUE_NOISE } from '../engine/post/shaders/blueNoise.glsl.ts';

const COLOR_DARK = '#0E0B08';
const COLOR_WARM = '#6B4230';
/** Where the warm pool sits, in screen space. Low and slightly left of centre,
 *  so the object reads as lit from that side even before the gobo exists. */
const GLOW_CENTER = new Vector2(0.42, 0.28);
const GLOW_RADIUS = 1.15;
/** Renders before everything; depth is neither tested nor written. */
const RENDER_ORDER = -1000;

// three's ShaderMaterial prefix already declares position and uv.
const VERTEX_SHADER = /* glsl */ `
varying vec2 v_uv;
void main() {
  v_uv = uv;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;
varying vec2 v_uv;
uniform vec3 u_colorDark;
uniform vec3 u_colorWarm;
uniform vec2 u_glowCenter;
uniform float u_glowRadius;
uniform float u_aspect;
${BLUE_NOISE}

vec3 sRGBToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

void main() {
  vec2 p = (v_uv - u_glowCenter) * vec2(u_aspect, 1.0);
  float d = length(p) / u_glowRadius;
  // Two smoothsteps rather than one: the inner falloff keeps the pool from
  // reading as a hard disc, the outer one carries it into the corners.
  float t = 1.0 - smoothstep(0.0, 1.0, d);
  t = t * t * (3.0 - 2.0 * t);

  vec3 srgb = mix(u_colorDark, u_colorWarm, t);
  srgb = ditherOutput(srgb, gl_FragCoord.xy);
  gl_FragColor = vec4(sRGBToLinear(srgb), 1.0);
}
`;

export class Background {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;

  constructor(blueNoise: BlueNoise, aspect: number) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position',
      new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geometry.setAttribute('uv', new Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));

    this.material = new ShaderMaterial({
      uniforms: {
        u_colorDark: new Uniform(new Color(COLOR_DARK).convertLinearToSRGB()),
        u_colorWarm: new Uniform(new Color(COLOR_WARM).convertLinearToSRGB()),
        u_glowCenter: new Uniform(GLOW_CENTER.clone()),
        u_glowRadius: new Uniform(GLOW_RADIUS),
        u_aspect: new Uniform(aspect),
        u_blueNoise: new Uniform(blueNoise.texture),
        u_blueNoiseScale: new Uniform(blueNoise.scale),
        u_blueNoiseOffset: new Uniform(blueNoise.offset),
        u_ditherAmount: new Uniform(1),
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,   // first thing drawn; there is nothing to blend with
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = RENDER_ORDER;
    this.mesh.matrixAutoUpdate = false;
  }

  setDither(enabled: boolean): void {
    (this.material.uniforms['u_ditherAmount'] as Uniform<number>).value = enabled ? 1 : 0;
  }

  setSize(width: number, height: number): void {
    (this.material.uniforms['u_aspect'] as Uniform<number>).value =
      width / Math.max(1, height);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
