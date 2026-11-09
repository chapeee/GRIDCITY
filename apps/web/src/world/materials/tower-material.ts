import { Color, ShaderMaterial, UniformsLib, UniformsUtils } from 'three';
import { cityGeometry, encoding, glow, neutrals } from '../../design/tokens';

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
    float smallest = min(toFace.x, min(toFace.y, toFace.z));
    float largest = max(toFace.x, max(toFace.y, toFace.z));
    float edgeDistance = toFace.x + toFace.y + toFace.z - smallest - largest;
    float edge = 1.0 - smoothstep(uEdgeWidth * 0.35, uEdgeWidth, edgeDistance);

    // CPU pulse. Frozen towers hold the phase they froze at: no motion.
    float time = vFrozenAt >= 0.0 ? vFrozenAt : uTime;
    float pulse = vPulseHz > 0.0 ? 0.72 + 0.28 * sin(6.2831853 * vPulseHz * time + vPulsePhase) : 1.0;

    vec3 color = uBodyColor;
    color += vGlowColor * vGlowIntensity * uGlowScale * pulse * edge;

    // Memory: thin horizontal light strips on the side faces, lit bottom-up.
    bool isSideFace = abs(vLocalNormal.y) < 0.5;
    if (isSideFace && vMemoryLitBands >= 0.0) {
      float bandPosition = (vLocalPosition.y / uTowerSize.y) * uBandCount;
      float bandIndex = floor(bandPosition);
      float stripe = 1.0 - smoothstep(0.035, 0.075, abs(fract(bandPosition) - 0.5));
      float awayFromVerticalEdges = smoothstep(uEdgeWidth * 2.0, uEdgeWidth * 3.5, max(toFace.x, toFace.z));
      vec3 bandColor = bandIndex < vMemoryLitBands
        ? vGlowColor * uBandIntensity * uGlowScale * (vGlowIntensity / uReferenceGlow)
        : uUnlitBandColor;
      color += bandColor * stripe * awayFromVerticalEdges;
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

export function createTowerMaterial(): ShaderMaterial {
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
        uTowerSize: {
          value: [cityGeometry.towerWidth, cityGeometry.towerHeight, cityGeometry.towerWidth],
        },
        uEdgeWidth: { value: cityGeometry.towerEdgeWidth },
        uBandCount: { value: encoding.memoryBandCount },
        uBandIntensity: { value: glow.memoryBandLit },
        // Bands dim together with the edges (e.g. stale hosts).
        uReferenceGlow: { value: glow.towerEdge },
      },
    ]),
  });
}
