/**
 * ERASER-1, built rather than loaded.
 *
 * A rectangular vinyl eraser with rounded corners and one visibly worn end
 * (CONCEPT.md section 3). Real thickness, real bevels, and a silhouette that
 * stays unambiguous from any angle — no placeholder primitive, and nothing
 * that only reads from one side.
 *
 * Construction: a subdivided cube is projected onto a rounded box, which gives
 * an exact analytic normal at every vertex, then one end is abraded by a soft
 * half-space clip along a fixed axis.
 *
 * The clip is a softplus, for two reasons. It is monotone along the axis — its
 * derivative is a sigmoid, which never reaches 1 — so the map cannot fold the
 * surface through itself the way an offset along the surface's own normal does
 * once the offset exceeds the corner radius. And because the displacement is
 * along a constant axis, the normal transform is an exact rank-one update
 * rather than something that has to be recovered by averaging face normals —
 * which is what would otherwise leave a visible crease down every seam of the
 * subdivided cube.
 */
import { BufferGeometry, BufferAttribute, Vector3 } from 'three';

/** 65 x 23 x 12 mm at 25 mm per world unit — the ERASER variant in SPEC.md. */
const HALF_EXTENTS = new Vector3(1.3, 0.46, 0.24);
const CORNER_RADIUS = 0.09;
/** Per cube face. 32 puts roughly nine quads across each corner fillet. */
const SEGMENTS = 32;

/** The worn end, as a direction. Angled so the wear reads as use, not damage. */
const WEAR_AXIS = new Vector3(1, 0.42, 0).normalize();
/** Distance along WEAR_AXIS of the abrasion plane. The far corner projects to
 *  1.377, so this takes roughly a third of that end away. */
const WEAR_PLANE = 1.02;
/** Rounding of the cut. Zero would be a machined chamfer, not wear. */
const WEAR_SOFTNESS = 0.13;
/** Below this the softplus derivative is treated as fully clipped, where the
 *  normal is the axis itself and the rank-one update would divide by zero. */
const CLIP_LIMIT = 0.999;

const CUBE_FACES: { u: Vector3; v: Vector3; w: Vector3 }[] = [
  { u: new Vector3(0, 0, -1), v: new Vector3(0, -1, 0), w: new Vector3(1, 0, 0) },
  { u: new Vector3(0, 0, 1), v: new Vector3(0, -1, 0), w: new Vector3(-1, 0, 0) },
  { u: new Vector3(1, 0, 0), v: new Vector3(0, 0, 1), w: new Vector3(0, 1, 0) },
  { u: new Vector3(1, 0, 0), v: new Vector3(0, 0, -1), w: new Vector3(0, -1, 0) },
  { u: new Vector3(1, 0, 0), v: new Vector3(0, -1, 0), w: new Vector3(0, 0, 1) },
  { u: new Vector3(-1, 0, 0), v: new Vector3(0, -1, 0), w: new Vector3(0, 0, -1) },
];

/** Smooth max(x, 0): flat below zero, slope one above, C-infinity between. */
function softplus(x: number, softness: number): number {
  const t = x / softness;
  // exp overflows past ~709; above 30 the function is the identity to 1e-13.
  if (t > 30) return x;
  if (t < -30) return 0;
  return softness * Math.log1p(Math.exp(t));
}

/** Derivative of softplus: a logistic, strictly inside (0, 1). */
function softplusSlope(x: number, softness: number): number {
  const t = x / softness;
  if (t > 30) return 1;
  if (t < -30) return 0;
  return 1 / (1 + Math.exp(-t));
}

const scratchCube = new Vector3();
const scratchInner = new Vector3();
const scratchNormal = new Vector3();

export interface EraserGeometryOptions {
  /** Scales the whole form; the configurator's three sizes use this. */
  scale?: number;
  /** 0 disables the worn end — the Pro Max variant is unused, not worn. */
  wear?: number;
}

export function createEraserGeometry(options: EraserGeometryOptions = {}): BufferGeometry {
  const scale = options.scale ?? 1;
  const wearStrength = options.wear ?? 1;
  const half = HALF_EXTENTS.clone().multiplyScalar(scale);
  const radius = CORNER_RADIUS * scale;
  const inner = half.clone().subScalar(radius);

  const perFace = (SEGMENTS + 1) * (SEGMENTS + 1);
  const vertexCount = perFace * 6;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  /** 0 on pristine vinyl, 1 on the abraded facet. The material reads it to
   *  roughen and dirty the worn end, which is where the graphite ends up. */
  const wearAttribute = new Float32Array(vertexCount);
  const indices = new Uint32Array(SEGMENTS * SEGMENTS * 6 * 6);

  let vertex = 0;
  let index = 0;
  for (let f = 0; f < CUBE_FACES.length; f++) {
    const face = CUBE_FACES[f];
    if (!face) continue;
    const base = vertex;
    for (let j = 0; j <= SEGMENTS; j++) {
      const b = (j / SEGMENTS) * 2 - 1;
      for (let i = 0; i <= SEGMENTS; i++) {
        const a = (i / SEGMENTS) * 2 - 1;
        scratchCube.set(
          face.u.x * a + face.v.x * b + face.w.x,
          face.u.y * a + face.v.y * b + face.w.y,
          face.u.z * a + face.v.z * b + face.w.z,
        );

        // Project onto the rounded box: clamp into the inner box, then step out
        // by the corner radius along the direction that took us there. On a
        // flat face that direction is the face normal; on a corner it is the
        // sphere normal. Both fall out of the same two lines.
        scratchInner.set(
          Math.max(-inner.x, Math.min(inner.x, scratchCube.x * half.x)),
          Math.max(-inner.y, Math.min(inner.y, scratchCube.y * half.y)),
          Math.max(-inner.z, Math.min(inner.z, scratchCube.z * half.z)),
        );
        scratchNormal.set(
          scratchCube.x * half.x - scratchInner.x,
          scratchCube.y * half.y - scratchInner.y,
          scratchCube.z * half.z - scratchInner.z,
        );
        if (scratchNormal.lengthSq() < 1e-12) scratchNormal.copy(face.w);
        scratchNormal.normalize();

        let px = scratchInner.x + scratchNormal.x * radius;
        let py = scratchInner.y + scratchNormal.y * radius;
        let pz = scratchInner.z + scratchNormal.z * radius;

        let wear = 0;
        if (wearStrength > 0) {
          const plane = WEAR_PLANE * scale;
          const softness = WEAR_SOFTNESS * scale;
          const beyond = px * WEAR_AXIS.x + py * WEAR_AXIS.y + pz * WEAR_AXIS.z - plane;
          const cut = softplus(beyond, softness) * wearStrength;
          if (cut > 0) {
            px -= WEAR_AXIS.x * cut;
            py -= WEAR_AXIS.y * cut;
            pz -= WEAR_AXIS.z * cut;

            // Exact normal under p -> p - A * f(dot(p, A)): the tangent map is
            // I - f'·A A^T, so the normal picks up A scaled by f' / (1 - f').
            const slope = softplusSlope(beyond, softness) * wearStrength;
            if (slope >= CLIP_LIMIT) {
              scratchNormal.copy(WEAR_AXIS);
            } else {
              const k = slope / (1 - slope);
              const along = scratchNormal.dot(WEAR_AXIS);
              scratchNormal.addScaledVector(WEAR_AXIS, k * along).normalize();
            }
            wear = slope;
          }
        }

        positions[vertex * 3] = px;
        positions[vertex * 3 + 1] = py;
        positions[vertex * 3 + 2] = pz;
        normals[vertex * 3] = scratchNormal.x;
        normals[vertex * 3 + 1] = scratchNormal.y;
        normals[vertex * 3 + 2] = scratchNormal.z;
        uvs[vertex * 2] = i / SEGMENTS;
        uvs[vertex * 2 + 1] = j / SEGMENTS;
        wearAttribute[vertex] = wear;
        vertex++;
      }
    }

    for (let j = 0; j < SEGMENTS; j++) {
      for (let i = 0; i < SEGMENTS; i++) {
        const a = base + j * (SEGMENTS + 1) + i;
        const b = a + 1;
        const c = a + SEGMENTS + 1;
        const d = c + 1;
        indices[index++] = a; indices[index++] = c; indices[index++] = b;
        indices[index++] = b; indices[index++] = c; indices[index++] = d;
      }
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setAttribute('a_wear', new BufferAttribute(wearAttribute, 1));
  geometry.setIndex(new BufferAttribute(indices, 1));
  // No computeVertexNormals: every normal above is exact. Recomputing them
  // would average within each cube face only, creasing all twelve seams.
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.name = 'eraser';
  return geometry;
}
