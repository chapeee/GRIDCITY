import { Color, ShaderMaterial, UniformsLib, UniformsUtils } from 'three';
import { accents, neutrals } from '../../design/tokens';

/**
 * Segmented ring at each tower's base: one arc per disk (max 4), each arc
 * filled by that disk's usage. Arcs over the disk threshold use the
 * degraded accent. Drawn as one instanced mesh.
 *
 * - aDiskFill      used/total per arc (x..w)
 * - aDiskOver      1 when that arc is over the threshold
 * - aArcCount      number of arcs; 0 hides the ring
 * - aRingColor     fill color (the host's status color)
 * - aRingIntensity glow strength; 0 hides the ring
 * - aSaturation    low when stale
 */
export const DISK_RING_INSTANCE_ATTRIBUTES = {
  aDiskFill: 4,
  aDiskOver: 4,
  aArcCount: 1,
  aRingColor: 3,
  aRingIntensity: 1,
  aSaturation: 1,
} as const;

const vertexShader = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>

  attribute vec4 aDiskFill;
  attribute vec4 aDiskOver;
  attribute float aArcCount;
  attribute vec3 aRingColor;
  attribute float aRingIntensity;
  attribute float aSaturation;

  varying vec2 vPlanar;
  varying vec4 vDiskFill;
  varying vec4 vDiskOver;
  varying float vArcCount;
  varying vec3 vRingColor;
  varying float vRingIntensity;
  varying float vSaturation;

  void main() {
    vPlanar = position.xz;
    vDiskFill = aDiskFill;
    vDiskOver = aDiskOver;
    vArcCount = aArcCount;
    vRingColor = aRingColor;
    vRingIntensity = aRingIntensity;
    vSaturation = aSaturation;

    vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>

  uniform float uGlowScale;
  uniform vec3 uDegradedColor;
  uniform vec3 uTrackColor;

  varying vec2 vPlanar;
  varying vec4 vDiskFill;
  varying vec4 vDiskOver;
  varying float vArcCount;
  varying vec3 vRingColor;
  varying float vRingIntensity;
  varying float vSaturation;

  float component(vec4 values, float index) {
    return index < 0.5 ? values.x : index < 1.5 ? values.y : index < 2.5 ? values.z : values.w;
  }

  void main() {
    if (vArcCount < 0.5 || vRingIntensity <= 0.0) discard;

    // Angle 0..1, starting at the front of the tower and running clockwise.
    float angle = fract(atan(vPlanar.x, vPlanar.y) / 6.2831853 + 1.0);
    float arcIndex = floor(angle * vArcCount);
    float withinArc = fract(angle * vArcCount);
    float gap = 0.018 * vArcCount;
    if (withinArc < gap || withinArc > 1.0 - gap) discard;

    float progress = (withinArc - gap) / (1.0 - 2.0 * gap);
    bool filled = progress <= component(vDiskFill, arcIndex);
    vec3 fillColor = component(vDiskOver, arcIndex) > 0.5 ? uDegradedColor : vRingColor;
    vec3 color = filled ? fillColor * vRingIntensity * uGlowScale : uTrackColor;

    float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = mix(vec3(luminance), color, vSaturation);

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export function createDiskRingMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader,
    fragmentShader,
    fog: true,
    uniforms: UniformsUtils.merge([
      UniformsLib.fog,
      {
        uGlowScale: { value: 1 },
        uDegradedColor: { value: new Color(accents.degraded) },
        uTrackColor: { value: new Color(neutrals.grid) },
      },
    ]),
  });
}
