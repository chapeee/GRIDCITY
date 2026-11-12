import { DEMO_HOST_COUNT } from '@app/shared';

/** Demo fleet settings, adjustable through the URL for screenshots and perf tests. */
export interface DemoOptions {
  /** `?hosts=50` */
  hostCount: number;
  /** `?seed=3` */
  seed: number;
  /** `?poll=500` (ms) */
  pollIntervalMs: number;
}

export const DEFAULT_DEMO_OPTIONS: DemoOptions = {
  hostCount: DEMO_HOST_COUNT,
  seed: 7,
  pollIntervalMs: 2000,
};

/** The GitHub Pages demo shows a bigger city: the hand-written fleet plus generated hosts. */
export const STATIC_DEMO_HOST_COUNT = 96;

const LIMITS = {
  hostCount: { min: 1, max: 200 },
  seed: { min: 0, max: 2 ** 31 },
  pollIntervalMs: { min: 250, max: 10_000 },
} as const;

/** Reads demo options from a query string, ignoring invalid values. */
export function parseDemoOptions(search: string): DemoOptions {
  const params = new URLSearchParams(search);
  const read = (param: string, key: keyof DemoOptions): number => {
    const value = Number(params.get(param));
    const { min, max } = LIMITS[key];
    return params.has(param) && Number.isInteger(value) && value >= min && value <= max
      ? value
      : DEFAULT_DEMO_OPTIONS[key];
  };
  return {
    hostCount: read('hosts', 'hostCount'),
    seed: read('seed', 'seed'),
    pollIntervalMs: read('poll', 'pollIntervalMs'),
  };
}
