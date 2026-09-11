/**
 * Uniforms every lit material holds by reference (rule 19).
 *
 * One object, shared. The gobo mutates `value` in place each frame; nothing
 * copies a uniform per material, so adding a material costs nothing per frame
 * and there is exactly one place a value can be wrong.
 */
import { Color, Matrix4, Texture, Uniform, Vector2, Vector3 } from 'three';

export interface SharedUniforms {
  u_time: Uniform<number>;
  u_goboMap: Uniform<Texture | null>;
  u_goboMatrix: Uniform<Matrix4>;
  u_goboColor: Uniform<Color>;
  u_goboIntensity: Uniform<number>;
  u_goboDirection: Uniform<Vector3>;
  u_pointer: Uniform<Vector2>;
  /** World position of the hero, for the paper's contact shadow. */
  u_heroPosition: Uniform<Vector3>;
}

export function createSharedUniforms(): SharedUniforms {
  return {
    u_time: new Uniform(0),
    u_goboMap: new Uniform<Texture | null>(null),
    u_goboMatrix: new Uniform(new Matrix4()),
    u_goboColor: new Uniform(new Color('#FFDDB8')),
    u_goboIntensity: new Uniform(1.5),
    u_goboDirection: new Uniform(new Vector3(0, 1, 0)),
    u_pointer: new Uniform(new Vector2()),
    u_heroPosition: new Uniform(new Vector3()),
  };
}
