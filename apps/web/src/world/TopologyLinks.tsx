import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { BufferAttribute, BufferGeometry, Color, ShaderMaterial, type LineSegments } from 'three';
import type { Link } from '@app/shared';
import { accents, neutrals } from '../design/tokens';
import type { TowerPlacement } from './city-layout';

interface TopologyLinksProps {
  links: readonly Link[];
  towers: readonly TowerPlacement[];
  /** Links touching this building are drawn bright; the rest fade back. */
  focusedId: string | null;
  /** Lite mode: no flow animation. */
  animate: boolean;
}

/** Height of the conduits above the floor; below every building's base light. */
const LINK_HEIGHT = 0.06;
/** Segments per link: enough for the flow to read as motion. */
const SEGMENTS = 24;

/** Strength per kind: declared is a plan, observed is a fact, balances is traffic. */
const KIND_STRENGTH: Record<Link['kind'], number> = {
  observed: 0.55,
  balances: 0.6,
  probes: 0.35,
  declared: 0.3,
};

const vertexShader = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  attribute float aT;
  attribute float aLength;
  attribute float aStrength;
  attribute float aFocus;
  attribute float aFlow;
  varying float vT;
  varying float vLength;
  varying float vStrength;
  varying float vFocus;
  varying float vFlow;
  void main() {
    vT = aT;
    vLength = aLength;
    vStrength = aStrength;
    vFocus = aFocus;
    vFlow = aFlow;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  uniform float uTime;
  uniform vec3 uColor;
  uniform vec3 uFocusColor;
  varying float vT;
  varying float vLength;
  varying float vStrength;
  varying float vFocus;
  varying float vFlow;
  void main() {
    // Pulses travel from the user to the used, one every ~3 world units.
    float phase = fract(vT * vLength / 3.0 - uTime * vFlow * 0.9);
    float dash = smoothstep(0.0, 0.35, phase) * (1.0 - smoothstep(0.55, 0.75, phase));
    float base = 0.18 + 0.82 * dash;
    float alpha = vStrength * base * mix(0.35, 1.0, vFocus);
    vec3 color = mix(uColor, uFocusColor, vFocus);
    gl_FragColor = vec4(color, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

/**
 * Light conduits on the floor between buildings that talk to each other:
 * declared dependencies, connections really seen on the hosts, and load
 * balancer targets. Direction is the flow of the pulses (from the user to
 * the used). One draw call for every link.
 */
export function TopologyLinks({ links, towers, focusedId, animate }: TopologyLinksProps) {
  const ref = useRef<LineSegments>(null);
  const positions = useMemo(() => new Map(towers.map((t) => [t.hostId, t] as const)), [towers]);

  const geometry = useMemo(() => {
    const drawn = links.filter((link) => positions.has(link.from) && positions.has(link.to));
    const vertexCount = drawn.length * SEGMENTS * 2;
    const position = new Float32Array(vertexCount * 3);
    const t = new Float32Array(vertexCount);
    const length = new Float32Array(vertexCount);
    const strength = new Float32Array(vertexCount);
    const focus = new Float32Array(vertexCount);
    const flow = new Float32Array(vertexCount);
    drawn.forEach((link, linkIndex) => {
      const from = positions.get(link.from)!;
      const to = positions.get(link.to)!;
      const dx = to.x - from.x;
      const dz = to.z - from.z;
      const total = Math.hypot(dx, dz);
      // Observed links sag slightly sideways so a declared and an observed link never overlap.
      const bow = link.kind === 'observed' ? 0.9 : link.kind === 'balances' ? -0.9 : 0;
      const nx = total > 0 ? -dz / total : 0;
      const nz = total > 0 ? dx / total : 0;
      const touched = focusedId !== null && (link.from === focusedId || link.to === focusedId);
      for (let s = 0; s < SEGMENTS; s++) {
        for (let end = 0; end < 2; end++) {
          const i = (linkIndex * SEGMENTS + s) * 2 + end;
          const u = (s + end) / SEGMENTS;
          const arc = Math.sin(u * Math.PI) * bow;
          position[i * 3] = from.x + dx * u + nx * arc;
          position[i * 3 + 1] = LINK_HEIGHT;
          position[i * 3 + 2] = from.z + dz * u + nz * arc;
          t[i] = u;
          length[i] = total;
          strength[i] = KIND_STRENGTH[link.kind];
          focus[i] = touched ? 1 : 0;
          flow[i] = animate && link.kind !== 'declared' ? 1 : animate ? 0.4 : 0;
        }
      }
    });
    const buffer = new BufferGeometry();
    buffer.setAttribute('position', new BufferAttribute(position, 3));
    buffer.setAttribute('aT', new BufferAttribute(t, 1));
    buffer.setAttribute('aLength', new BufferAttribute(length, 1));
    buffer.setAttribute('aStrength', new BufferAttribute(strength, 1));
    buffer.setAttribute('aFocus', new BufferAttribute(focus, 1));
    buffer.setAttribute('aFlow', new BufferAttribute(flow, 1));
    return buffer;
  }, [links, positions, focusedId, animate]);

  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: false,
        fog: true,
        uniforms: {
          uTime: { value: 0 },
          uColor: { value: new Color(neutrals.gridSection).multiplyScalar(2.2) },
          uFocusColor: { value: new Color(accents.online) },
          fogColor: { value: new Color(neutrals.void) },
          fogNear: { value: 60 },
          fogFar: { value: 260 },
        },
      }),
    [],
  );

  useFrame(({ clock, scene }) => {
    material.uniforms.uTime!.value = clock.elapsedTime;
    const fog = scene.fog as { color: Color; near: number; far: number } | null;
    if (fog) {
      material.uniforms.fogColor!.value = fog.color;
      material.uniforms.fogNear!.value = fog.near;
      material.uniforms.fogFar!.value = fog.far;
    }
  });

  if (geometry.getAttribute('position').count === 0) return null;
  return <lineSegments ref={ref} geometry={geometry} material={material} raycast={() => null} />;
}
