import { Leva, useControls } from 'leva';
import { useEffect } from 'react';
import { TOKEN_TUNING, useWorldTuning } from './use-world-tuning';

/**
 * Development-only leva sliders for glow and bloom. Loaded with a dynamic
 * import behind `import.meta.env.DEV`, so it is absent from production builds.
 */
export default function DevTuningPanel({ hidden }: { hidden: boolean }) {
  const values = useControls('World', {
    glowScale: { value: TOKEN_TUNING.glowScale, min: 0, max: 3, step: 0.05 },
    bloomIntensity: { value: TOKEN_TUNING.bloomIntensity, min: 0, max: 4, step: 0.05 },
    bloomThreshold: { value: TOKEN_TUNING.bloomThreshold, min: 0, max: 2, step: 0.01 },
  });

  useEffect(() => {
    useWorldTuning.setState(values);
  }, [values]);

  return <Leva hidden={hidden} collapsed={false} />;
}
