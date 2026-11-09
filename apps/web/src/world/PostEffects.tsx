import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import { postProcessing } from '../design/tokens';

interface PostEffectsProps {
  bloomIntensity: number;
  bloomThreshold: number;
}

/**
 * Bloom and vignette only. Chromatic aberration is reserved for the jack-in
 * transition (Phase 4). Not mounted at all in lite mode.
 */
export function PostEffects({ bloomIntensity, bloomThreshold }: PostEffectsProps) {
  return (
    <EffectComposer multisampling={4} enableNormalPass={false}>
      <Bloom
        mipmapBlur
        intensity={bloomIntensity}
        luminanceThreshold={bloomThreshold}
        luminanceSmoothing={postProcessing.bloomSmoothing}
      />
      <Vignette eskil={false} offset={0.25} darkness={postProcessing.vignetteDarkness} />
    </EffectComposer>
  );
}
