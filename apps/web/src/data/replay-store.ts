import { createDemoReplayFrame, ReplayFrameSchema, type ReplayFrame } from '@app/shared';
import { create } from 'zustand';
import { useFleetStore } from './fleet-store';
import { useServerLink } from './server-link';

const DAY_MS = 86_400_000;
/** How much history one second of playback covers, per speed step. */
export const PLAY_SPEEDS = [
  { label: '1 min/s', msPerSecond: 60_000 },
  { label: '10 min/s', msPerSecond: 600_000 },
  { label: '1 h/s', msPerSecond: 3_600_000 },
] as const;

interface ReplayStore {
  /** Time travel is on: the city shows `frame`, never live data. */
  active: boolean;
  at: number;
  since: number;
  until: number;
  playing: boolean;
  speed: number;
  frame: ReplayFrame | null;
  loading: boolean;
  error: string | null;
  open(): void;
  close(): void;
  seek(at: number): void;
  setPlaying(playing: boolean): void;
  setSpeed(index: number): void;
}

let requestSeq = 0;
let debounce: ReturnType<typeof setTimeout> | undefined;

/**
 * Time travel. Frames come from the local server (recorded history), or,
 * for the in-browser demo, are generated like the rest of the demo. Seeking
 * is debounced so dragging the scrubber does not flood the server.
 */
export const useReplayStore = create<ReplayStore>()((set, get) => ({
  active: false,
  at: 0,
  since: 0,
  until: 0,
  playing: false,
  speed: 1,
  frame: null,
  loading: false,
  error: null,
  open: () => {
    const now = Date.now();
    set({
      active: true,
      at: now - 60 * 60_000,
      since: now - 7 * DAY_MS,
      until: now,
      playing: false,
      frame: null,
      error: null,
    });
    load(now - 60 * 60_000);
  },
  close: () => set({ active: false, playing: false, frame: null }),
  seek: (at) => {
    const { since, until } = get();
    const clamped = Math.min(until, Math.max(since, at));
    set({ at: clamped });
    clearTimeout(debounce);
    debounce = setTimeout(() => load(clamped), 90);
  },
  setPlaying: (playing) => set({ playing }),
  setSpeed: (index) => set({ speed: Math.max(0, Math.min(PLAY_SPEEDS.length - 1, index)) }),
}));

async function load(at: number): Promise<void> {
  const seq = ++requestSeq;
  useReplayStore.setState({ loading: true });
  try {
    if (useServerLink.getState().source !== 'server') {
      const { hosts, resources } = useFleetStore.getState();
      const until = useReplayStore.getState().until;
      const frame = createDemoReplayFrame(
        hosts.map((h) => h.id),
        resources.map((r) => r.id),
        at,
        until,
      );
      if (seq === requestSeq) useReplayStore.setState({ frame, loading: false, error: null });
      return;
    }
    const response = await fetch(`/api/replay?at=${Math.round(at)}`, {
      credentials: 'same-origin',
    });
    const body = (await response.json()) as {
      since: number;
      until: number;
      frame: unknown;
      error?: string;
    };
    if (!response.ok) throw new Error(body.error ?? `replay failed (${response.status})`);
    const frame = ReplayFrameSchema.parse(body.frame);
    if (seq === requestSeq) {
      useReplayStore.setState({
        frame,
        since: body.since,
        until: body.until,
        loading: false,
        error: null,
      });
    }
  } catch (reason) {
    if (seq === requestSeq)
      useReplayStore.setState({ loading: false, error: (reason as Error).message });
  }
}
