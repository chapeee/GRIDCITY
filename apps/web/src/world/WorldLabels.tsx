import { Billboard, Text } from '@react-three/drei';
import labelFontUrl from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff?url';
import { accents, neutrals } from '../design/tokens';
import { buildingHeight } from './building-geometry';
import type { DistrictPlacement, TowerPlacement } from './city-layout';
import type { HostVisual, LabelTone } from './host-visuals';

interface WorldLabelsProps {
  towers: readonly TowerPlacement[];
  districts: readonly DistrictPlacement[];
  visuals: ReadonlyMap<string, HostVisual>;
  /** While a host is focused, host labels are hidden: the HUD names it, and nearby labels would loom. */
  focusedHostId: string | null;
  /** Hosts where an AI agent is running a command right now: "AI: <command>". */
  agentBusy?: ReadonlyMap<string, string>;
  /** Clicking a district name frames that district. */
  onSelectDistrict?(name: string): void;
}

/** Label colors per tone. Bundled font: no network request for text. */
const NAME_COLOR: Record<LabelTone, string> = {
  normal: neutrals.text,
  warning: neutrals.text,
  dim: neutrals.muted,
};
const CAPTION_COLOR: Record<LabelTone, string> = {
  normal: neutrals.muted,
  warning: accents.degraded,
  dim: neutrals.muted,
};

/** Names float this far above the top of each building. */
const NAME_OFFSET = 1.5;
/** District names float just above the floor, in front of their district. */
const DISTRICT_LABEL_HEIGHT = 0.9;
const DISTRICT_LABEL_FRONT_OFFSET = 5;

/**
 * Names stay readable where buildings stand close together: a dark outline
 * separates them from glowing edges, and they are drawn after the city
 * without depth testing, so a building in front never hides the name of the
 * one behind it.
 */
const READABLE = {
  outlineWidth: '9%',
  outlineColor: neutrals.base,
  outlineOpacity: 0.9,
  renderOrder: 10,
  'material-depthTest': false,
  'material-depthWrite': false,
} as const;

/** Host names, status captions and floating district names (troika text). */
export function WorldLabels({
  towers,
  districts,
  visuals,
  focusedHostId,
  agentBusy,
  onSelectDistrict,
}: WorldLabelsProps) {
  return (
    <group>
      {focusedHostId === null &&
        towers.map((tower) => {
          const visual = visuals.get(tower.hostId);
          const tone = visual?.labelTone ?? 'dim';
          const busy = agentBusy?.get(tower.hostId);
          const caption = busy ? `AI: ${busy}` : visual?.caption;
          return (
            <Billboard
              key={tower.hostId}
              position={[tower.x, buildingHeight(tower.shape ?? 'tower') + NAME_OFFSET, tower.z]}
            >
              <Text
                font={labelFontUrl}
                fontSize={0.62}
                color={NAME_COLOR[tone]}
                {...READABLE}
                anchorX="center"
                anchorY="bottom"
                raycast={() => null}
              >
                {shortLabel(tower.label ?? tower.hostId)}
              </Text>
              {caption && (
                <Text
                  font={labelFontUrl}
                  fontSize={0.4}
                  color={busy ? accents.online : CAPTION_COLOR[tone]}
                  {...READABLE}
                  anchorX="center"
                  anchorY="top"
                  position={[0, -0.12, 0]}
                  maxWidth={9}
                  textAlign="center"
                  raycast={() => null}
                >
                  {caption}
                </Text>
              )}
            </Billboard>
          );
        })}

      {districts.map((district) => (
        <Billboard
          key={district.name}
          position={[
            (district.minX + district.maxX) / 2,
            DISTRICT_LABEL_HEIGHT,
            district.maxZ + DISTRICT_LABEL_FRONT_OFFSET,
          ]}
        >
          <Text
            font={labelFontUrl}
            fontSize={1.3}
            letterSpacing={0.3}
            color={neutrals.muted}
            anchorX="center"
            anchorY="bottom"
            onClick={(event) => {
              event.stopPropagation();
              onSelectDistrict?.(district.name);
            }}
            onPointerOver={() => (document.body.style.cursor = 'pointer')}
            onPointerOut={() => (document.body.style.cursor = '')}
          >
            {district.name.toUpperCase()}
          </Text>
        </Billboard>
      ))}
    </group>
  );
}

/** Longest name drawn in full; neighbours stand about this far apart. */
const MAX_LABEL_CHARS = 16;

/**
 * Long names ("media-1794434186338") would run into the next building's
 * name. They keep their start and end ("media-1794…86338"); the HUD shows
 * the full name when the building is focused.
 */
export function shortLabel(name: string): string {
  if (name.length <= MAX_LABEL_CHARS) return name;
  const tail = 5;
  return `${name.slice(0, MAX_LABEL_CHARS - tail - 1)}…${name.slice(-tail)}`;
}
