import { Color, ShaderMaterial, UniformsLib, UniformsUtils } from 'three';
import { cityGeometry, glow, neutrals } from '../../design/tokens';
import { shapeShaderParams } from '../building-geometry';
import type { BuildingShape } from '../city-layout';

/**
 * One material for every tower (drawn as a single instanced mesh).
 *
 * Per-instance attributes carry the encodings from `computeHostVisual`:
 * - aGlowColor / aGlowIntensity  edge glow (status)
 * - aPulseHz / aPulsePhase        edge pulse (CPU)
 * - aMemoryLitBands               lit horizontal bands (memory); < 0 = none
 * - aSaturation                   1 normally, low when stale
 * - aFrozenAt                     shader time at which motion froze; < 0 = live
 *
 * The dark body itself is never emissive, so an offline tower is just a
 * dark volume against the fog.
 */
export const TOWER_INSTANCE_ATTRIBUTES = {
  aGlowColor: 3,
  aGlowIntensity: 1,
  aPulseHz: 1,
  aPulsePhase: 1,
  aMemoryLitBands: 1,
  aSaturation: 1,
  aFrozenAt: 1,
} as const;

const vertexShader = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>

  attribute vec3 aGlowColor;
  attribute float aGlowIntensity;
  attribute float aPulseHz;
  attribute float aPulsePhase;
  attribute float aMemoryLitBands;
  attribute float aSaturation;
  attribute float aFrozenAt;

  varying vec3 vLocalPosition;
  varying vec3 vLocalNormal;
  varying vec3 vGlowColor;
  varying float vGlowIntensity;
  varying float vPulseHz;
  varying float vPulsePhase;
  varying float vMemoryLitBands;
  varying float vSaturation;
  varying float vFrozenAt;

  void main() {
    vLocalPosition = position;
    vLocalNormal = normal;
    vGlowColor = aGlowColor;
    vGlowIntensity = aGlowIntensity;
    vPulseHz = aPulseHz;
    vPulsePhase = aPulsePhase;
    vMemoryLitBands = aMemoryLitBands;
    vSaturation = aSaturation;
    vFrozenAt = aFrozenAt;

    vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>

  uniform float uTime;
  uniform float uGlowScale;
  uniform vec3 uBodyColor;
  uniform vec3 uUnlitBandColor;
  uniform vec3 uTowerSize;
  uniform float uEdgeWidth;
  uniform float uBandCount;
  uniform float uBandIntensity;
  uniform float uReferenceGlow;
  // 0 box tower, 1 disc stack (drum), 2 hexagonal prism, 3 warehouse (roof cells)
  uniform int uShape;
  uniform float uRadius;
  uniform vec2 uDisc;      // disc height, gap
  uniform vec2 uRoof;      // roof columns, rows

  varying vec3 vLocalPosition;
  varying vec3 vLocalNormal;
  varying vec3 vGlowColor;
  varying float vGlowIntensity;
  varying float vPulseHz;
  varying float vPulsePhase;
  varying float vMemoryLitBands;
  varying float vSaturation;
  varying float vFrozenAt;

  void main() {
    // Distance to the nearest box edge: on any face, one axis is ~0 (the face
    // itself); the second-smallest axis distance is the distance to an edge.
    vec3 halfSize = uTowerSize * 0.5;
    vec3 centered = vLocalPosition - vec3(0.0, halfSize.y, 0.0);
    vec3 toFace = halfSize - abs(centered);
    bool isSideFace = abs(vLocalNormal.y) < 0.5;
    float edgeDistance;
    float awayFromVerticalEdges = 1.0;
    if (uShape == 1) {
      // Disc stack: rims of every disc.
      float period = uDisc.x + uDisc.y;
      float inDisc = mod(vLocalPosition.y, period);
      float toCap = min(inDisc, uDisc.x - inDisc);
      float toSide = uRadius - length(vLocalPosition.xz);
      edgeDistance = isSideFace ? toCap : toSide;
    } else if (uShape == 2) {
      // Hexagonal prism: top/bottom rims and the six vertical corners.
      float sector = 1.0471976;
      float angle = atan(vLocalPosition.x, vLocalPosition.z);
      float toCorner = abs(angle - round(angle / sector) * sector) * length(vLocalPosition.xz);
      float faceAngle = (floor(angle / sector) + 0.5) * sector;
      float toSide = uRadius * 0.8660254 - dot(vLocalPosition.xz, vec2(sin(faceAngle), cos(faceAngle)));
      float toCap = min(vLocalPosition.y, uTowerSize.y - vLocalPosition.y);
      edgeDistance = isSideFace ? min(toCap, toCorner) : toSide;
      awayFromVerticalEdges = smoothstep(uEdgeWidth * 2.0, uEdgeWidth * 3.5, toCorner);
    } else {
      float smallest = min(toFace.x, min(toFace.y, toFace.z));
      float largest = max(toFace.x, max(toFace.y, toFace.z));
      edgeDistance = toFace.x + toFace.y + toFace.z - smallest - largest;
      awayFromVerticalEdges = smoothstep(uEdgeWidth * 2.0, uEdgeWidth * 3.5, max(toFace.x, toFace.z));
    }
    float edge = 1.0 - smoothstep(uEdgeWidth * 0.35, uEdgeWidth, edgeDistance);

    // CPU pulse. Frozen towers hold the phase they froze at: no motion.
    float time = vFrozenAt >= 0.0 ? vFrozenAt : uTime;
    float pulse = vPulseHz > 0.0 ? 0.72 + 0.28 * sin(6.2831853 * vPulseHz * time + vPulsePhase) : 1.0;

    vec3 color = uBodyColor;
    color += vGlowColor * vGlowIntensity * uGlowScale * pulse * edge;

    vec3 litBandColor = vGlowColor * uBandIntensity * uGlowScale * (vGlowIntensity / uReferenceGlow);
    if (uShape == 3) {
      // Warehouse: a grid of roof cells, lit front-left first (stored bytes).
      if (vLocalNormal.y > 0.5 && vMemoryLitBands >= 0.0) {
        vec2 roofUv = (vLocalPosition.xz + halfSize.xz) / uTowerSize.xz;
        vec2 cell = floor(roofUv * uRoof);
        vec2 inCell = fract(roofUv * uRoof);
        float inset = step(0.16, inCell.x) * step(inCell.x, 0.84) * step(0.2, inCell.y) * step(inCell.y, 0.8);
        float cellIndex = (uRoof.y - 1.0 - cell.y) * uRoof.x + cell.x;
        color += (cellIndex < vMemoryLitBands ? litBandColor : uUnlitBandColor) * inset * 0.8;
      }
    } else if (isSideFace && vMemoryLitBands >= 0.0) {
      // Bands lit bottom-up: memory (towers) or connections (drums, prisms).
      float bandIndex;
      float stripe;
      if (uShape == 1) {
        float period = uDisc.x + uDisc.y;
        bandIndex = floor(vLocalPosition.y / period);
        stripe = 1.0 - smoothstep(0.04, 0.08, abs(mod(vLocalPosition.y, period) - uDisc.x * 0.5) / period);
      } else {
        float bandPosition = (vLocalPosition.y / uTowerSize.y) * uBandCount;
        bandIndex = floor(bandPosition);
        stripe = 1.0 - smoothstep(0.035, 0.075, abs(fract(bandPosition) - 0.5));
      }
      color += (bandIndex < vMemoryLitBands ? litBandColor : uUnlitBandColor) * stripe * awayFromVerticalEdges;
    }

    // Stale data is desaturated.
    float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = mix(vec3(luminance), color, vSaturation);

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export function createTowerMaterial(shape: BuildingShape = 'tower'): ShaderMaterial {
  const params = shapeShaderParams(shape);
  return new ShaderMaterial({
    vertexShader,
    fragmentShader,
    fog: true,
    uniforms: UniformsUtils.merge([
      UniformsLib.fog,
      {
        uTime: { value: 0 },
        uGlowScale: { value: 1 },
        uBodyColor: { value: new Color(neutrals.grid).multiplyScalar(0.55) },
        uUnlitBandColor: { value: new Color(neutrals.muted).multiplyScalar(glow.memoryBandUnlit) },
        uTowerSize: { value: [...params.size] },
        uEdgeWidth: { value: cityGeometry.towerEdgeWidth },
        uBandCount: { value: params.bandCount },
        uShape: { value: params.mode },
        uRadius: { value: 'radius' in params ? (params.radius ?? 0) : 0 },
        uDisc: { value: 'disc' in params && params.disc ? [...params.disc] : [1, 0] },
        uRoof: { value: 'roof' in params && params.roof ? [...params.roof] : [1, 1] },
        uBandIntensity: { value: glow.memoryBandLit },
        // Bands dim together with the edges (e.g. stale hosts).
        uReferenceGlow: { value: glow.towerEdge },
      },
    ]),
  });
}
