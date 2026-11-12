import { Canvas, useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import { atmosphere, camera as cameraTokens, neutrals } from '../design/tokens';
import { useUiStore } from '../ui/ui-store';
import { CameraRig } from './CameraRig';
import { CityFloor } from './CityFloor';
import { DiskRings } from './DiskRings';
import { FocusMarker } from './FocusMarker';
import { FreezeTracker } from './freeze-tracker';
import { NetworkParticles } from './NetworkParticles';
import { PerfProbe } from './PerfProbe';
import { PostEffects } from './PostEffects';
import type { BuildingShape } from './city-layout';
import { ResourceCages } from './ResourceCages';
import { TowerField } from './TowerField';
import { TopologyLinks } from './TopologyLinks';
import { CityAtmosphere } from './CityAtmosphere';
import { TroubleBeacons } from './TroubleBeacons';

/** One instanced mesh per shape; a shape with no buildings draws nothing. */
const BUILDING_SHAPES: readonly BuildingShape[] = [
  'tower',
  'drum',
  'prism',
  'caged-drum',
  'warehouse',
  'beacon',
  'gate',
];
import type { CityModel } from './use-city-model';
import { useWorldTuning } from './use-world-tuning';
import { WorldLabels } from './WorldLabels';
import { useAgentStore } from '../data/agent-store';
import { worstOpenSeverity } from '@app/shared';
import { useFleetStore } from '../data/fleet-store';
import { useReplayStore } from '../data/replay-store';
import { AttackRings } from './AttackRings';
import { BuildingHighlight } from './BuildingHighlight';

interface WorldSceneProps {
  model: CityModel;
}

/**
 * The 3D city. Renders with WebGL2: the post-processing and 3D text
 * libraries in our stack do not support WebGPURenderer yet. Renderer setup
 * stays in this one component so WebGPU can be adopted later.
 */
export function WorldScene({ model }: WorldSceneProps) {
  const liteMode = useUiStore((store) => store.liteMode);
  const threats = useFleetStore((store) => store.threats);
  const replaying = useReplayStore((store) => store.active);
  // Live findings only: time travel shows the past, never today's attacks.
  const attackSeverities = useMemo(
    () => (replaying ? new Map() : worstOpenSeverity(threats)),
    [threats, replaying],
  );
  const focusedHostId = useUiStore((store) => store.focusedHostId);
  const focusHost = useUiStore((store) => store.focusHost);
  const focusDistrict = useUiStore((store) => store.focusDistrict);
  // The terminal covers the whole screen: stop rendering the city meanwhile.
  const terminalOpen = useUiStore((store) => store.terminal?.phase === 'open');
  const tuning = useWorldTuning();
  const [freezeTracker] = useState(() => new FreezeTracker());
  const { layout, visuals, links } = model;
  const activity = useAgentStore((store) => store.state?.activity);
  const agentBusy = useMemo(
    () => new Map((activity ?? []).map((run) => [run.hostId, run.command] as const)),
    [activity],
  );

  return (
    <Canvas
      className="world-canvas"
      flat
      frameloop={terminalOpen ? 'never' : 'always'}
      dpr={liteMode ? 1 : [1, 2]}
      gl={{ antialias: liteMode, powerPreference: 'high-performance' }}
      camera={{ fov: cameraTokens.fieldOfView, near: 0.5, far: 900, position: [0, 80, 110] }}
      onCreated={({ gl }) => watchContextLoss(gl.domElement)}
    >
      <color attach="background" args={[neutrals.base]} />
      <fog attach="fog" args={[atmosphere.fogColor, atmosphere.fogNear, atmosphere.fogFar]} />

      <CityAtmosphere stars={!liteMode} />
      <CityFloor districts={layout.districts} tones={model.districtTones} reflections={!liteMode} />
      <TroubleBeacons towers={layout.towers} statuses={model.statuses} visuals={visuals} />
      <AttackRings towers={layout.towers} severities={attackSeverities} animate={!liteMode} />
      {BUILDING_SHAPES.map((shape) => (
        <TowerField
          key={shape}
          shape={shape}
          towers={layout.towers}
          visuals={visuals}
          freezeTracker={freezeTracker}
          glowScale={tuning.glowScale}
          onSelect={focusHost}
        />
      ))}
      <ResourceCages towers={layout.towers} />
      <TopologyLinks
        links={links}
        towers={layout.towers}
        focusedId={focusedHostId}
        animate={!liteMode}
      />
      <DiskRings towers={layout.towers} visuals={visuals} glowScale={tuning.glowScale} />
      <BuildingHighlight towers={layout.towers} />
      <FocusMarker tower={layout.towers.find((tower) => tower.hostId === focusedHostId)} />
      {!liteMode && (
        <NetworkParticles
          towers={layout.towers}
          visuals={visuals}
          freezeTracker={freezeTracker}
          glowScale={tuning.glowScale}
        />
      )}
      <WorldLabels
        agentBusy={agentBusy}
        towers={layout.towers}
        districts={layout.districts}
        visuals={visuals}
        focusedHostId={focusedHostId}
        onSelectDistrict={focusDistrict}
      />

      <CameraRig layout={layout} focusedHostId={focusedHostId} />
      {!liteMode && (
        <PostEffects
          bloomIntensity={tuning.bloomIntensity}
          bloomThreshold={tuning.bloomThreshold}
        />
      )}
      <PerfProbe />
      <ReadySignal hostCount={layout.towers.length} />
    </Canvas>
  );
}

/**
 * A lost WebGL context leaves a frozen image that would look live. Truth
 * first: tell the user instead (three.js restores the context when it can).
 */
function watchContextLoss(canvas: HTMLCanvasElement): void {
  const { setRenderingLost } = useUiStore.getState();
  canvas.addEventListener('webglcontextlost', () => setRenderingLost(true));
  canvas.addEventListener('webglcontextrestored', () => setRenderingLost(false));
}

/** Frames to render with hosts before the world counts as ready. */
const READY_AFTER_FRAMES = 30;

/**
 * Marks `<html data-world-ready>` once the city has rendered, so automated
 * screenshots wait for real content instead of guessing with timeouts.
 */
function ReadySignal({ hostCount }: { hostCount: number }) {
  const frames = useRef(0);
  useEffect(() => () => void delete document.documentElement.dataset.worldReady, []);
  useFrame(() => {
    if (hostCount === 0 || frames.current > READY_AFTER_FRAMES) return;
    frames.current += 1;
    if (frames.current > READY_AFTER_FRAMES) document.documentElement.dataset.worldReady = 'true';
  });
  return null;
}
