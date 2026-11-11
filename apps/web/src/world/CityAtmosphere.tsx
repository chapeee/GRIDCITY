import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  ShaderMaterial,
} from 'three';
import { accents, atmosphere, neutrals } from '../design/tokens';

/**
 * The space the city floats in: a dome that glows faintly cyan at the
 * horizon and fades to the void overhead, a soft light band where floor and
 * sky meet, and fixed stars. Atmosphere only: nothing here moves or encodes
 * data, so any motion on screen still means a measurement.
 */
const DOME_RADIUS = 700;

const domeVertex = /* glsl */ `
  varying vec3 vDirection;
  void main() {
    vDirection = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const domeFragment = /* glsl */ `
  uniform vec3 uVoid;
  uniform vec3 uHorizon;
  uniform vec3 uGlow;
  varying vec3 vDirection;
  void main() {
    float height = vDirection.y;
    // Darkest overhead, a deep blue band near the horizon, a thin cyan line at it.
    float band = 1.0 - smoothstep(0.0, 0.55, height);
    float line = exp(-pow(height * 22.0, 2.0));
    vec3 color = mix(uVoid, uHorizon, band) + uGlow * line * 0.35;
    // Below the horizon: the floor hides it, keep it void.
    color = mix(color, uVoid, 1.0 - smoothstep(-0.05, 0.0, height));
    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`;

const starVertex = /* glsl */ `
  attribute float aSize;
  attribute float aBrightness;
  varying float vBrightness;
  void main() {
    vBrightness = aBrightness;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize;
    gl_Position = projectionMatrix * mv;
  }
`;

const starFragment = /* glsl */ `
  uniform vec3 uColor;
  varying float vBrightness;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float alpha = (1.0 - smoothstep(0.0, 0.5, d)) * vBrightness;
    gl_FragColor = vec4(uColor * alpha, alpha);
  }
`;

/** Deterministic pseudo-random, so the sky is the same on every load. */
function seeded(seed: number) {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) % 4294967296;
    return value / 4294967296;
  };
}

export function CityAtmosphere({ stars = true }: { stars?: boolean }) {
  const domeMaterial = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: domeVertex,
        fragmentShader: domeFragment,
        side: BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          uVoid: { value: new Color(atmosphere.fogColor) },
          uHorizon: { value: new Color(neutrals.grid).multiplyScalar(0.9) },
          uGlow: { value: new Color(accents.online) },
        },
      }),
    [],
  );

  const starGeometry = useMemo(() => {
    const random = seeded(20261111);
    const count = 900;
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const brightness = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      // Upper hemisphere only, denser toward the horizon like a real sky photo.
      const theta = random() * Math.PI * 2;
      const y = Math.pow(random(), 1.6) * 0.95 + 0.04;
      const r = Math.sqrt(1 - y * y);
      positions.set([Math.cos(theta) * r * 650, y * 650, Math.sin(theta) * r * 650], i * 3);
      sizes[i] = 1 + random() * 2.2;
      brightness[i] = 0.15 + Math.pow(random(), 3) * 0.6;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('aSize', new BufferAttribute(sizes, 1));
    geometry.setAttribute('aBrightness', new BufferAttribute(brightness, 1));
    return geometry;
  }, []);

  const starMaterial = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: starVertex,
        fragmentShader: starFragment,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        uniforms: { uColor: { value: new Color(neutrals.text) } },
      }),
    [],
  );

  // The sky is at infinity: it travels with the camera, so panning or zooming far
  // never reaches its edge, and the stars never shift against the horizon.
  const groupRef = useRef<Group>(null);
  useFrame(({ camera }) => {
    groupRef.current?.position.set(camera.position.x, 0, camera.position.z);
  });

  return (
    <group ref={groupRef}>
      <mesh material={domeMaterial} raycast={() => null} renderOrder={-10}>
        <sphereGeometry args={[DOME_RADIUS, 48, 24]} />
      </mesh>
      {stars && <points geometry={starGeometry} material={starMaterial} raycast={() => null} />}
    </group>
  );
}
