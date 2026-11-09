import { create } from 'zustand';

/** Rendering statistics for the dev performance overlay. */
export interface PerfStats {
  fps: number;
  /** Average frame time over the last sampling window, ms. */
  frameMs: number;
  /** Draw calls in the last frame, including post-processing passes. */
  drawCalls: number;
  triangles: number;
}

export const usePerfStore = create<PerfStats>()(() => ({
  fps: 0,
  frameMs: 0,
  drawCalls: 0,
  triangles: 0,
}));
