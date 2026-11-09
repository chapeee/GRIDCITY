import { OrbitControls } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import gsap from 'gsap';
import { useEffect, useRef, type ComponentRef } from 'react';
import { Vector3 } from 'three';
import { camera as cameraTokens, durations, easings } from '../design/tokens';
import { focusPose, overviewPose, type CameraPose } from './camera-poses';
import type { CityLayout } from './city-layout';

interface CameraRigProps {
  layout: CityLayout;
  focusedHostId: string | null;
}

type OrbitControlsHandle = ComponentRef<typeof OrbitControls>;

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Orbit camera with smooth damping. Focusing a host flies there with a GSAP
 * tween; clearing focus flies back to the overview. No walking, no WASD.
 */
export function CameraRig({ layout, focusedHostId }: CameraRigProps) {
  const camera = useThree((state) => state.camera);
  const controlsRef = useRef<OrbitControlsHandle>(null);
  const tweenRef = useRef<gsap.core.Tween | null>(null);
  const hasFramedCity = useRef(false);

  // Frame the city once, as soon as there is one to frame.
  useEffect(() => {
    const controls = controlsRef.current;
    if (hasFramedCity.current || !controls || layout.towers.length === 0) return;
    const pose = overviewPose(layout);
    camera.position.copy(pose.position);
    controls.target.copy(pose.target);
    controls.update();
    hasFramedCity.current = true;
  }, [camera, layout]);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls || !hasFramedCity.current) return;

    const tower = focusedHostId ? layout.towers.find((t) => t.hostId === focusedHostId) : undefined;
    const pose: CameraPose = tower
      ? focusPose(tower, camera.position, controls.target)
      : overviewPose(layout);
    const duration = prefersReducedMotion()
      ? 0
      : (tower ? durations.cameraFlyTo : durations.cameraReturn) / 1000;

    const fromPosition = camera.position.clone();
    const fromTarget = controls.target.clone();
    const progress = { value: 0 };
    const scratch = new Vector3();

    tweenRef.current?.kill();
    tweenRef.current = gsap.to(progress, {
      value: 1,
      duration,
      ease: easings.cameraFlyTo,
      onUpdate: () => {
        camera.position.copy(scratch.lerpVectors(fromPosition, pose.position, progress.value));
        controls.target.lerpVectors(fromTarget, pose.target, progress.value);
        controls.update();
      },
    });

    // Grabbing the camera mid-flight hands control back to the user.
    const cancelOnUserInput = () => tweenRef.current?.kill();
    controls.addEventListener('start', cancelOnUserInput);
    return () => {
      controls.removeEventListener('start', cancelOnUserInput);
    };
    // The layout changes on every poll only when hosts change; re-run then too.
  }, [camera, focusedHostId, layout]);

  useEffect(() => () => void tweenRef.current?.kill(), []);

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enableDamping
      dampingFactor={0.08}
      minDistance={cameraTokens.minDistance}
      maxDistance={cameraTokens.maxDistance}
      maxPolarAngle={cameraTokens.maxPolarAngle}
      // Keyboard panning would be WASD-like movement; the palette handles keyboard travel.
      keys={{ LEFT: '', UP: '', RIGHT: '', BOTTOM: '' }}
    />
  );
}
