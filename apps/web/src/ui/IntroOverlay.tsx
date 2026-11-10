import { useEffect } from 'react';
import { durations } from '../design/tokens';
import { useUiStore } from './ui-store';

/**
 * The entrance: a lens opens and you pass through it "into the machine",
 * then the camera descends onto the city (CameraRig). Nothing is staged:
 * towers start as faint unknown outlines and light up only as real
 * connections succeed. Any key or click skips it; it is auto-skipped after
 * the first visit and can be replayed from the command palette.
 */
export function IntroOverlay() {
  const playing = useUiStore((store) => store.introPlaying);

  useEffect(() => {
    if (!playing) return;
    const { endIntro } = useUiStore.getState();
    const finish = setTimeout(endIntro, durations.introLens + durations.introCamera);
    const skip = (event: Event) => {
      event.stopPropagation();
      event.preventDefault();
      endIntro();
    };
    // Capture phase: the skipping key must not also trigger a shortcut.
    window.addEventListener('keydown', skip, { capture: true, once: true });
    window.addEventListener('pointerdown', skip, { capture: true, once: true });
    return () => {
      clearTimeout(finish);
      window.removeEventListener('keydown', skip, { capture: true });
      window.removeEventListener('pointerdown', skip, { capture: true });
    };
  }, [playing]);

  if (!playing) return null;
  return (
    <div className="intro" role="presentation">
      <div className="intro-lens" />
      <div className="intro-title">
        <span className="intro-name">{__PROJECT_NAME__}</span>
        <span className="intro-tagline">entering the machine</span>
      </div>
      <p className="intro-skip">press any key to skip</p>
    </div>
  );
}
