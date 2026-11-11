import { Grid, MeshReflectorMaterial } from '@react-three/drei';
import { useMemo } from 'react';
import { Color, MeshBasicMaterial } from 'three';
import { accents, cityGeometry, neutrals } from '../design/tokens';
import type { DistrictPlacement } from './city-layout';
import type { DistrictTone } from './district-visuals';

interface CityFloorProps {
  districts: readonly DistrictPlacement[];
  /** District name -> plate edge tone (docs/VISUAL_LANGUAGE.md, "Districts"). */
  tones: ReadonlyMap<string, DistrictTone>;
  /** Full mode: a soft reflection of the city on the floor. Lite mode: none. */
  reflections: boolean;
}

/** Plate height: a low step the buildings stand on. */
const PLATE_HEIGHT = cityGeometry.plateHeight;
/** How far a plate reaches past its outermost buildings. */
const PLATE_MARGIN = 0.6;
const EDGE_WIDTH = 0.09;
const BRACKET_LENGTH = 3.2;
const BRACKET_WIDTH = 0.16;

/** Edge light per tone; brackets at the corners are brighter. Above 1 blooms. */
const TONE_LIGHT: Record<DistrictTone, { color: string; edge: number; bracket: number }> = {
  online: { color: accents.online, edge: 0.55, bracket: 1.5 },
  attention: { color: accents.degraded, edge: 0.9, bracket: 2.1 },
  unknown: { color: neutrals.muted, edge: 0.6, bracket: 0.9 },
};

/**
 * The ground: a dark, faintly reflective floor (the city's light shows in it),
 * the grid, and one raised plate per district. A plate's edge is the
 * district's only light: amber when something inside needs attention, cyan
 * when every measured member is online, muted otherwise.
 */
export function CityFloor({ districts, tones, reflections }: CityFloorProps) {
  const plateMaterial = useMemo(
    () =>
      new MeshBasicMaterial({
        color: new Color(neutrals.surface).multiplyScalar(0.9),
        transparent: true,
        opacity: 0.82,
        fog: true,
      }),
    [],
  );
  const lightMaterials = useMemo(() => {
    const make = (color: string, intensity: number) =>
      new MeshBasicMaterial({
        color: new Color(color).multiplyScalar(intensity),
        toneMapped: false,
        fog: true,
      });
    return Object.fromEntries(
      (Object.keys(TONE_LIGHT) as DistrictTone[]).map((tone) => [
        tone,
        {
          edge: make(TONE_LIGHT[tone].color, TONE_LIGHT[tone].edge),
          bracket: make(TONE_LIGHT[tone].color, TONE_LIGHT[tone].bracket),
        },
      ]),
    ) as Record<DistrictTone, { edge: MeshBasicMaterial; bracket: MeshBasicMaterial }>;
  }, []);

  return (
    <group>
      {/* Lite mode draws no floor plane: the scene background is the same color. */}
      {reflections && (
        <mesh rotation-x={-Math.PI / 2} position={[0, -0.03, 0]} raycast={() => null}>
          <planeGeometry args={[1400, 1400]} />
          <MeshReflectorMaterial
            resolution={512}
            blur={[260, 80]}
            mixBlur={1}
            mixStrength={1.4}
            mixContrast={1}
            depthScale={0.9}
            minDepthThreshold={0.3}
            maxDepthThreshold={1.3}
            roughness={1}
            metalness={0.6}
            mirror={0}
            color={neutrals.base}
          />
        </mesh>
      )}
      <Grid
        infiniteGrid
        position={[0, 0, 0]}
        cellSize={cityGeometry.slotSpacing / 4}
        cellThickness={0.5}
        cellColor={neutrals.grid}
        sectionSize={cityGeometry.slotSpacing}
        sectionThickness={0.9}
        sectionColor={neutrals.gridSection}
        fadeDistance={420}
        fadeStrength={1.6}
        raycast={() => null}
      />
      {districts.map((district) => (
        <DistrictPlate
          key={district.name}
          district={district}
          plate={plateMaterial}
          light={lightMaterials[tones.get(district.name) ?? 'unknown']}
        />
      ))}
    </group>
  );
}

function DistrictPlate({
  district,
  plate,
  light,
}: {
  district: DistrictPlacement;
  plate: MeshBasicMaterial;
  light: { edge: MeshBasicMaterial; bracket: MeshBasicMaterial };
}) {
  const minX = district.minX - PLATE_MARGIN;
  const maxX = district.maxX + PLATE_MARGIN;
  const minZ = district.minZ - PLATE_MARGIN;
  const maxZ = district.maxZ + PLATE_MARGIN;
  const width = maxX - minX;
  const depth = maxZ - minZ;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const y = PLATE_HEIGHT + 0.01;

  const corners: [number, number, number, number][] = [
    [minX, minZ, 1, 1],
    [maxX, minZ, -1, 1],
    [maxX, maxZ, -1, -1],
    [minX, maxZ, 1, -1],
  ];

  return (
    <group>
      <mesh position={[cx, PLATE_HEIGHT / 2, cz]} material={plate} raycast={() => null}>
        <boxGeometry args={[width, PLATE_HEIGHT, depth]} />
      </mesh>
      {/* Edges: four thin light strips along the top rim. */}
      <mesh position={[cx, y, minZ]} material={light.edge} raycast={() => null}>
        <boxGeometry args={[width, 0.03, EDGE_WIDTH]} />
      </mesh>
      <mesh position={[cx, y, maxZ]} material={light.edge} raycast={() => null}>
        <boxGeometry args={[width, 0.03, EDGE_WIDTH]} />
      </mesh>
      <mesh position={[minX, y, cz]} material={light.edge} raycast={() => null}>
        <boxGeometry args={[EDGE_WIDTH, 0.03, depth]} />
      </mesh>
      <mesh position={[maxX, y, cz]} material={light.edge} raycast={() => null}>
        <boxGeometry args={[EDGE_WIDTH, 0.03, depth]} />
      </mesh>
      {/* Corner brackets: brighter L-shapes that frame the plate. */}
      {corners.map(([x, z, sx, sz]) => (
        <group key={`${x}:${z}`}>
          <mesh
            position={[x + (sx * BRACKET_LENGTH) / 2, y + 0.01, z]}
            material={light.bracket}
            raycast={() => null}
          >
            <boxGeometry args={[BRACKET_LENGTH, 0.05, BRACKET_WIDTH]} />
          </mesh>
          <mesh
            position={[x, y + 0.01, z + (sz * BRACKET_LENGTH) / 2]}
            material={light.bracket}
            raycast={() => null}
          >
            <boxGeometry args={[BRACKET_WIDTH, 0.05, BRACKET_LENGTH]} />
          </mesh>
        </group>
      ))}
    </group>
  );
}
