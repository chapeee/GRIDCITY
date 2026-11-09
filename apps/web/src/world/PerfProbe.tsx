import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { performanceBudget } from '../design/tokens';
import { usePerfStore } from '../ui/perf-store';
import { useUiStore } from '../ui/ui-store';

/** How often stats are published to the overlay, ms. */
const PUBLISH_INTERVAL_MS = 500;
/** A frame longer than this means the tab was paused or throttled, not slow rendering. */
const MAX_MEASURED_FRAME_SECONDS = 1;

/**
 * Measures frame time and draw calls (including post-processing passes) and
 * suggests lite mode when frames stay slow. Renders nothing.
 */
export function PerfProbe() {
  const gl = useThree((state) => state.gl);
  // startedAt 0 = not started; set on the first frame (no impure calls during render).
  const sampleWindow = useRef({ frames: 0, totalMs: 0, startedAt: 0, slowSince: 0 });

  // Count every pass of a frame, not just the last one: reset manually.
  useEffect(() => {
    gl.info.autoReset = false;
    return () => {
      gl.info.autoReset = true;
    };
  }, [gl]);

  useFrame((_, deltaSeconds) => {
    const stats = sampleWindow.current;
    const { calls, triangles } = gl.info.render; // totals of the previous frame
    gl.info.reset();

    const now = performance.now();
    if (stats.startedAt === 0) {
      stats.startedAt = now;
      return;
    }
    // Hidden or throttled tabs produce long frame gaps that say nothing about
    // rendering cost: they are still reported, but never trigger the lite
    // mode suggestion.
    if (document.hidden || deltaSeconds > MAX_MEASURED_FRAME_SECONDS) stats.slowSince = -1;
    stats.frames += 1;
    stats.totalMs += deltaSeconds * 1000;
    if (now - stats.startedAt < PUBLISH_INTERVAL_MS) return;

    const frameMs = stats.totalMs / stats.frames;
    usePerfStore.setState({
      fps: Math.round((stats.frames * 1000) / (now - stats.startedAt)),
      frameMs: Math.round(frameMs * 10) / 10,
      drawCalls: calls,
      triangles,
    });

    // Suggest lite mode after a sustained stretch of slow frames.
    // slowSince: 0 = frames are fast, -1 = this window was paused/throttled.
    if (stats.slowSince === -1) {
      stats.slowSince = 0;
    } else if (frameMs > performanceBudget.liteSuggestFrameMs) {
      if (stats.slowSince === 0) stats.slowSince = now;
      if (now - stats.slowSince > performanceBudget.liteSuggestAfterMs) {
        useUiStore.getState().suggestLiteMode();
      }
    } else {
      stats.slowSince = 0;
    }

    stats.frames = 0;
    stats.totalMs = 0;
    stats.startedAt = now;
  });

  return null;
}
