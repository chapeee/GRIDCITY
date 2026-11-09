import { AdditiveBlending, ShaderMaterial } from 'three';
import { cityGeometry, encoding, glow } from '../../design/tokens';

/**
 * Faint particles rising around a tower; their number encodes network
 * throughput. Every tower owns a fixed pool of particles (one draw call for
 * the whole city). A particle is visible when its slot index is below the
 * tower's active slot count: `activeSlots = rate × lifetime`, which yields
 * exactly `rate` new particles per second on average.
 *
 * Per-particle attributes: aSeed, aSlot (static); aActiveSlots, aColor,
 * aFrozenAt, aSaturation (copied from the tower on every update).
 */
const vertexShader = /* glsl */ `
  attribute float aSeed;
  attribute float aSlot;
  attribute float aActiveSlots;
  attribute vec3 aColor;
  attribute float aFrozenAt;
  attribute float aSaturation;

  uniform float uTime;
  uniform float uLifetime;
  uniform float uRiseHeight;
  uniform float uRadius;
  uniform float uSize;
  uniform float uPixelRatio;

  varying vec3 vColor;
  varying float vAlpha;

  float hash(float n) {
    return fract(sin(n) * 43758.5453123);
  }

  void main() {
    float visible = step(aSlot + 0.5, aActiveSlots);
    float time = aFrozenAt >= 0.0 ? aFrozenAt : uTime;
    float life = fract(time / uLifetime + hash(aSeed * 1.37));
    float angle = hash(aSeed * 7.13) * 6.2831853;
    float radius = uRadius * (0.85 + 0.3 * hash(aSeed * 3.71));
    vec3 offset = vec3(cos(angle) * radius, life * uRiseHeight, sin(angle) * radius);

    vec4 mvPosition = modelViewMatrix * vec4(position + offset, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = visible * uSize * uPixelRatio * (60.0 / -mvPosition.z);

    vAlpha = visible * smoothstep(0.0, 0.15, life) * (1.0 - smoothstep(0.7, 1.0, life));
    float luminance = dot(aColor, vec3(0.2126, 0.7152, 0.0722));
    vColor = mix(vec3(luminance), aColor, aSaturation);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uIntensity;
  uniform float uGlowScale;

  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    float distanceFromCenter = length(gl_PointCoord - 0.5);
    float softness = 1.0 - smoothstep(0.15, 0.5, distanceFromCenter);
    float alpha = vAlpha * softness * 0.75;
    if (alpha <= 0.002) discard;
    gl_FragColor = vec4(vColor * uIntensity * uGlowScale, alpha);
    #include <colorspace_fragment>
  }
`;

export function createParticleMaterial(pixelRatio: number): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uLifetime: { value: encoding.particleLifetimeSec },
      uRiseHeight: { value: cityGeometry.towerHeight * 1.35 },
      uRadius: { value: cityGeometry.towerWidth * 0.68 },
      uSize: { value: 2.2 },
      uPixelRatio: { value: pixelRatio },
      uIntensity: { value: glow.particle },
      uGlowScale: { value: 1 },
    },
  });
}
