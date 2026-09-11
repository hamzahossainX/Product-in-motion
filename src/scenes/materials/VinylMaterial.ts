/**
 * Soft matte vinyl.
 *
 * three's MeshStandardMaterial already carries the split-sum IBL against a
 * prefiltered environment, so the job here is to add the gobo to its lighting
 * term rather than to reimplement PBR badly. The projected light is injected
 * as a real light contribution — it respects the surface normal and the
 * projector frustum — not painted over the result.
 *
 * CONCEPT.md calls for a subsurface quality; a true SSS pass is not worth the
 * frame time on a 12 mm object, so the same read is bought with a wrap-lit
 * term: light bends a little past the terminator, which is the part of
 * subsurface scattering the eye actually notices at this scale.
 */
import { Color, MeshStandardMaterial, Texture, Uniform } from 'three';
import type { SharedUniforms } from '../../engine/SharedUniforms.ts';
import { GOBO_SAMPLE, GOBO_UNIFORMS, GOBO_VARYING, GOBO_VERTEX } from '../../engine/post/shaders/gobo.glsl.ts';

const COLOR = '#EFE6D6';
const ROUGHNESS = 0.68;
const METALNESS = 0;
const ENV_MAP_INTENSITY = 0.5;
/** How far light wraps past the terminator, as a fraction of the hemisphere. */
const WRAP_AMOUNT = 0.35;
const WRAP_COLOR = '#E0A183';
/** Subsurface is a hint, not a light source. At full strength it flattens the
 *  terminator into the same value as the lit side, which is the opposite of
 *  what it should do. */
const WRAP_STRENGTH = 0.16;
/** The worn facet is where the graphite ends up: rougher and dirtier than the
 *  pristine vinyl, which is most of what makes it read as used. */
const WEAR_ROUGHNESS = 0.28;
const WEAR_DARKEN = 0.34;
const WEAR_COLOR = '#6B6259';
/** Where the pool starts falling off, as a fraction of its radius. */
const POOL_INNER = 0.28;
const CONTACT_RADIUS = 1.9;
const CONTACT_STRENGTH = 0.82;
const PROGRAM_CACHE_KEY = 'vinyl-gobo-v1';

export interface VinylMaterialOptions {
  map?: Texture;
  ormMap?: Texture;
  color?: string;
  roughness?: number;
  envMapIntensity?: number;
  /** Geometry without an `a_wear` attribute must not compile the branch that
   *  reads it — an unbound attribute silently reads as zero and the shader
   *  would still be paying for it. */
  wearAware?: boolean;
  /** Radius of the lit pool, in world units, centred on the hero. Directional
   *  lights and an environment map do not fall off with distance, so a large
   *  flat surface stays evenly lit out to the horizon and reads as a white
   *  desert. This is the falloff a real source would have provided — and it
   *  follows the object, because once the object is placed by the DOM the
   *  world origin is not where the subject is any more. */
  lightPoolRadius?: number;
  /** Fakes the occlusion under the hero object. There are no shadow maps in
   *  this renderer, and an object with no contact shadow reads as pasted on. */
  contactShadow?: boolean;
}

export function createVinylMaterial(
  shared: SharedUniforms,
  options: VinylMaterialOptions = {},
): MeshStandardMaterial {
  const wearAware = options.wearAware ?? true;
  const lightPoolRadius = options.lightPoolRadius ?? 0;
  const contactShadow = options.contactShadow ?? false;
  const material = new MeshStandardMaterial({
    color: new Color(options.color ?? COLOR),
    roughness: options.roughness ?? ROUGHNESS,
    metalness: METALNESS,
    envMapIntensity: options.envMapIntensity ?? ENV_MAP_INTENSITY,
  });
  if (options.map) material.map = options.map;
  if (options.ormMap) {
    material.roughnessMap = options.ormMap;
    material.aoMap = options.ormMap;
  }

  material.onBeforeCompile = (shader) => {
    // Shared by reference (rule 19): the gobo mutates these in place and every
    // material that uses them sees the change without a per-frame copy.
    shader.uniforms['u_goboMap'] = shared.u_goboMap;
    shader.uniforms['u_goboMatrix'] = shared.u_goboMatrix;
    shader.uniforms['u_goboColor'] = shared.u_goboColor;
    shader.uniforms['u_goboIntensity'] = shared.u_goboIntensity;
    shader.uniforms['u_goboDirection'] = shared.u_goboDirection;
    shader.uniforms['u_wrapColor'] = new Uniform(new Color(WRAP_COLOR));
    if (contactShadow || lightPoolRadius > 0) {
      shader.uniforms['u_heroPosition'] = shared.u_heroPosition;
    }
    if (wearAware) shader.uniforms['u_wearColor'] = new Uniform(new Color(WEAR_COLOR));

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${GOBO_VARYING}` +
        (wearAware ? '\nattribute float a_wear;\nvarying float v_wear;' : ''))
      .replace('#include <project_vertex>',
        `${wearAware ? 'v_wear = a_wear;\n' : ''}${GOBO_VERTEX}\n#include <project_vertex>`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        `#include <common>\n${GOBO_VARYING}\n${GOBO_UNIFORMS}\nuniform vec3 u_wrapColor;\n` +
        (wearAware ? `uniform vec3 u_wearColor;\nvarying float v_wear;\n` : '') +
        (contactShadow || lightPoolRadius > 0 ? `uniform vec3 u_heroPosition;\n` : '') + GOBO_SAMPLE)
      // Before lighting, so the worn end scatters differently rather than just
      // being painted a different colour afterwards.
      .replace('#include <roughnessmap_fragment>', wearAware ? /* glsl */ `
        #include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + v_wear * ${WEAR_ROUGHNESS}, 0.04, 1.0);
      ` : '#include <roughnessmap_fragment>')
      .replace('#include <color_fragment>', /* glsl */ `
        #include <color_fragment>
        ${wearAware ? `diffuseColor.rgb = mix(diffuseColor.rgb, u_wearColor, v_wear * ${WEAR_DARKEN});` : ''}
        ${lightPoolRadius > 0 ? `
        {
          float pool = 1.0 - smoothstep(${POOL_INNER}, 1.0,
            length(v_goboWorldPosition.xz - u_heroPosition.xz) / ${lightPoolRadius.toFixed(3)});
          diffuseColor.rgb *= pool;
        }` : ''}
        ${contactShadow ? `
        {
          vec2 toHero = v_goboWorldPosition.xz - u_heroPosition.xz;
          float contact = exp(-dot(toHero, toHero) / ${(CONTACT_RADIUS * CONTACT_RADIUS).toFixed(3)});
          diffuseColor.rgb *= 1.0 - ${CONTACT_STRENGTH} * contact;
        }` : ''}
      `)
      .replace('#include <lights_fragment_end>', /* glsl */ `
        #include <lights_fragment_end>
        {
          // The view matrix is orthonormal, so its inverse rotation is its
          // transpose — which is what right-multiplying by it computes.
          vec3 worldNormal = normalize(normal * mat3(viewMatrix));
          // BRDF_Lambert, not a raw multiply: without the 1/pi this arrives as
          // roughly three times the irradiance of every other light in the
          // scene and flattens whatever it touches.
          reflectedLight.directDiffuse +=
            sampleGobo(v_goboWorldPosition, worldNormal) * BRDF_Lambert(diffuseColor.rgb);

          // Wrap-lit fill standing in for subsurface: strongest exactly at the
          // terminator, absent where the surface already faces the light.
          float wrap = dot(worldNormal, u_goboDirection);
          float bleed = clamp((wrap + ${WRAP_AMOUNT}) / (1.0 + ${WRAP_AMOUNT}), 0.0, 1.0)
                      - clamp(wrap, 0.0, 1.0);
          reflectedLight.indirectDiffuse +=
            u_wrapColor * diffuseColor.rgb * bleed * ${WRAP_STRENGTH};
        }
      `);
  };
  material.customProgramCacheKey = () =>
    `${PROGRAM_CACHE_KEY}:${wearAware ? 'wear' : 'plain'}:${lightPoolRadius}:${contactShadow}`;
  material.name = 'vinyl';
  return material;
}
