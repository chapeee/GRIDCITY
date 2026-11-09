import { useFrame } from '@react-three/fiber';
import { Bloom, ChromaticAberration, EffectComposer, Vignette } from '@react-three/postprocessing';
import type { ChromaticAberrationEffect } from 'postprocessing';
import { useRef, useState } from 'react';
import { Vector2 } from 'three';
import { postProcessing } from '../design/tokens';
import { transitionEffect } from './transition-effect';

interface PostEffectsProps {
  bloomIntensity: number;
  bloomThreshold: number;
}

/** Channel offset at full transition strength (fraction of the screen). */
const MAX_ABERRATION = new Vector2(0.012, 0.006);

/**
 * Bloom and vignette, plus chromatic aberration that is zero except during
 * the jack-in transition. Not mounted at all in lite mode.
 */
export function PostEffects({ bloomIntensity, bloomThreshold }: PostEffectsProps) {
  const aberrationRef = useRef<ChromaticAberrationEffect>(null);
  // One stable vector, mutated each frame (never re-created on render).
  const [offset] = useState(() => new Vector2(0, 0));

  useFrame(() => {
    offset.copy(MAX_ABERRATION).multiplyScalar(transitionEffect.aberration);
    if (aberrationRef.current) aberrationRef.current.offset = offset;
  });

  return (
    <EffectComposer multisampling={4} enableNormalPass={false}>
      <Bloom
        mipmapBlur
        intensity={bloomIntensity}
        luminanceThreshold={bloomThreshold}
        luminanceSmoothing={postProcessing.bloomSmoothing}
      />
      <ChromaticAberration
        ref={aberrationRef}
        offset={offset}
        radialModulation={false}
        modulationOffset={0}
      />
      <Vignette eskil={false} offset={0.25} darkness={postProcessing.vignetteDarkness} />
    </EffectComposer>
  );
}
