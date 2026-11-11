import { OrbitControls } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import gsap from 'gsap';
import { useEffect, useRef, type ComponentRef } from 'react';
import { MOUSE, TOUCH, Vector3 } from 'three';
import { camera as cameraTokens, cityGeometry, durations, easings } from '../design/tokens';
import { useUiStore } from '../ui/ui-store';
import { districtPose, focusPose, overviewPose, type CameraPose } from './camera-poses';
import type { CityLayout } from './city-layout';
import { transitionEffect } from './transition-effect';

interface CameraRigProps {
  layout: CityLayout;
  focusedHostId: string | null;
}

type OrbitControlsHandle = ComponentRef<typeof OrbitControls>;

/**
 * Camera flights and the jack-in dive follow the wall clock. GSAP's default
 * lag smoothing treats a frame slower than 500 ms as 33 ms, which on a slow
 * machine stretched the 450 ms dive to many seconds.
 */
gsap.ticker.lagSmoothing(0);

/** How far past the outermost district the look-at point may pan (world units). */
const PAN_MARGIN = 40;
const ARROW_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
const isTypingTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Orbit camera with smooth damping. Focusing a host flies there with a GSAP
 * tween; clearing focus flies back to the overview. No walking, no WASD.
 *
 * Jacking in dives the camera into the focused tower (under 500 ms, any key
 * or click skips it); leaving the terminal surfaces back to the focus view.
 */
export function CameraRig({ layout, focusedHostId }: CameraRigProps) {
  const camera = useThree((state) => state.camera);
  // The canvas itself, not the wrapper: wheel and drags over panels and the command
  // palette must never move the camera.
  const canvas = useThree((state) => state.gl.domElement);
  const controlsRef = useRef<OrbitControlsHandle>(null);
  const tweenRef = useRef<gsap.core.Tween | null>(null);
  const hasFramedCity = useRef(false);
  const terminalPhase = useUiStore((store) => store.terminal?.phase ?? null);
  const terminalHostId = useUiStore((store) => store.terminal?.hostId ?? null);
  const ambientMode = useUiStore((store) => store.ambientMode);
  const introPlaying = useUiStore((store) => store.introPlaying);
  const focusedDistrict = useUiStore((store) => store.focusedDistrict);
  const introTweenRef = useRef<gsap.core.Tween | null>(null);

  // Arrow keys pan from anywhere on the page. Only the key listener goes on the body:
  // drei's keyEvents prop would connect the wheel and drag handlers there too, and
  // then scrolling a panel or the command palette would zoom the camera.
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    controls.listenToKeyEvents(document.body);
    return () => controls.stopListenToKeyEvents();
  }, []);

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

  // Intro: descend from high above onto the overview, after the lens phase.
  useEffect(() => {
    const controls = controlsRef.current;
    if (!introPlaying || !controls || layout.towers.length === 0) return;
    const pose = overviewPose(layout);
    const from = pose.position
      .clone()
      .multiplyScalar(2.6)
      .setY(pose.position.y * 4);
    const progress = { value: 0 };
    camera.position.copy(from);
    controls.target.copy(pose.target);
    controls.update();
    introTweenRef.current?.kill();
    introTweenRef.current = gsap.to(progress, {
      value: 1,
      delay: durations.introLens / 1000,
      duration: durations.introCamera / 1000,
      ease: easings.introCamera,
      onUpdate: () => {
        camera.position.lerpVectors(from, pose.position, progress.value);
        controls.update();
      },
    });
    // Restart only when the intro (re)starts or the first layout arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [introPlaying, layout.towers.length > 0]);

  // Skipping the intro jumps the camera to the end of the descent.
  useEffect(() => {
    if (!introPlaying) introTweenRef.current?.progress(1);
  }, [introPlaying]);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls || !hasFramedCity.current) return;

    const tower = focusedHostId ? layout.towers.find((t) => t.hostId === focusedHostId) : undefined;
    const district = focusedDistrict
      ? layout.districts.find((d) => d.name === focusedDistrict)
      : undefined;
    const pose: CameraPose = tower
      ? focusPose(tower, camera.position, controls.target)
      : district
        ? districtPose(district)
        : overviewPose(layout);
    const flightMs = ambientMode
      ? durations.ambientFly
      : tower || district
        ? durations.cameraFlyTo
        : durations.cameraReturn;
    const duration = prefersReducedMotion() ? 0 : flightMs / 1000;

    const fromPosition = camera.position.clone();
    const fromTarget = controls.target.clone();
    const progress = { value: 0 };
    const scratch = new Vector3();

    tweenRef.current?.kill();
    tweenRef.current = gsap.to(progress, {
      value: 1,
      duration,
      ease: ambientMode ? easings.ambientFly : easings.cameraFlyTo,
      onUpdate: () => {
        camera.position.copy(scratch.lerpVectors(fromPosition, pose.position, progress.value));
        controls.target.lerpVectors(fromTarget, pose.target, progress.value);
        controls.update();
      },
    });

    // Grabbing the camera mid-flight hands control back to the user.
    const cancelOnUserInput = () => {
      tweenRef.current?.kill();
      if (useUiStore.getState().ambientMode) useUiStore.getState().setAmbientMode(false);
    };
    controls.addEventListener('start', cancelOnUserInput);
    return () => {
      controls.removeEventListener('start', cancelOnUserInput);
    };
    // The layout changes only when hosts change; re-run then too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, focusedHostId, focusedDistrict, layout]);

  // The jack-in dive and its reverse.
  useEffect(() => {
    if (terminalPhase !== 'diving' && terminalPhase !== 'surfacing') return;
    const controls = controlsRef.current;
    const tower = layout.towers.find((t) => t.hostId === terminalHostId);
    const { setTerminalPhase, closeTerminal } = useUiStore.getState();
    const finish = () => (terminalPhase === 'diving' ? setTerminalPhase('open') : closeTerminal());
    if (!controls || !tower) return finish();

    const towerCenter = new Vector3(
      tower.x,
      cityGeometry.towerHeight * cameraTokens.focusHeightRatio,
      tower.z,
    );
    const fromPosition = camera.position.clone();
    const fromTarget = controls.target.clone();
    let toPosition: Vector3;
    let toTarget: Vector3;
    if (terminalPhase === 'diving') {
      // Straight through the tower's skin: end inside it, still looking ahead.
      const forward = new Vector3().subVectors(towerCenter, camera.position).normalize();
      toPosition = towerCenter.clone().addScaledVector(forward, -0.2);
      toTarget = towerCenter.clone().addScaledVector(forward, 6);
      controls.enabled = false;
    } else {
      const pose = focusPose(
        tower,
        camera.position.clone().setY(camera.position.y + 10),
        towerCenter,
      );
      toPosition = pose.position;
      toTarget = pose.target;
    }

    const durationMs = terminalPhase === 'diving' ? durations.jackIn : durations.jackOut;
    const progress = { value: 0 };
    tweenRef.current?.kill();
    tweenRef.current = gsap.to(progress, {
      value: 1,
      duration: prefersReducedMotion() ? 0 : durationMs / 1000,
      ease: terminalPhase === 'diving' ? easings.jackIn : easings.jackOut,
      onUpdate: () => {
        camera.position.lerpVectors(fromPosition, toPosition, progress.value);
        controls.target.lerpVectors(fromTarget, toTarget, progress.value);
        controls.update();
        // Aberration peaks at the moment of entering/leaving the machine.
        transitionEffect.aberration =
          terminalPhase === 'diving' ? progress.value : 1 - progress.value;
      },
      onComplete: () => {
        transitionEffect.aberration = 0;
        if (terminalPhase === 'surfacing') controls.enabled = true;
        finish();
      },
    });

    // The transition is skippable: any key or click jumps to the end.
    const skip = () => tweenRef.current?.progress(1);
    window.addEventListener('keydown', skip, { once: true });
    window.addEventListener('pointerdown', skip, { once: true });
    return () => {
      window.removeEventListener('keydown', skip);
      window.removeEventListener('pointerdown', skip);
    };
    // Only phase changes start a transition; layout updates mid-dive are ignored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalPhase, terminalHostId]);

  useEffect(() => () => void tweenRef.current?.kill(), []);

  // Panning (left drag, two fingers, arrow keys) keeps the zoom and never leaves the city:
  // the look-at point is clamped to the city's footprint plus a margin.
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const margin = PAN_MARGIN;
    const clamp = () => {
      const { minX, maxX, minZ, maxZ } = layout.bounds;
      const x = Math.min(maxX + margin, Math.max(minX - margin, controls.target.x));
      const z = Math.min(maxZ + margin, Math.max(minZ - margin, controls.target.z));
      if (x !== controls.target.x || z !== controls.target.z) {
        camera.position.x += x - controls.target.x;
        camera.position.z += z - controls.target.z;
        controls.target.set(x, controls.target.y, z);
      }
    };
    controls.addEventListener('change', clamp);
    // Arrow keys pan without an OrbitControls 'start' event: stop any flight by hand.
    const onArrow = (event: KeyboardEvent) => {
      if (!ARROW_KEYS.has(event.key) || isTypingTarget(event.target)) return;
      tweenRef.current?.kill();
      if (useUiStore.getState().ambientMode) useUiStore.getState().setAmbientMode(false);
    };
    window.addEventListener('keydown', onArrow);
    return () => {
      controls.removeEventListener('change', clamp);
      window.removeEventListener('keydown', onArrow);
    };
  }, [camera, layout]);

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      domElement={canvas}
      enableDamping
      dampingFactor={0.08}
      minDistance={cameraTokens.minDistance}
      maxDistance={cameraTokens.maxDistance}
      maxPolarAngle={cameraTokens.maxPolarAngle}
      autoRotate={ambientMode && !terminalPhase}
      autoRotateSpeed={cameraTokens.ambientOrbitSpeed}
      // A map, not a flight sim: drag moves the city under you at the same zoom,
      // right-drag (or two fingers) orbits, the wheel zooms, arrow keys pan too.
      mouseButtons={{ LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE }}
      touches={{ ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_ROTATE }}
      screenSpacePanning={false}
      panSpeed={1.1}
      keyPanSpeed={cameraTokens.keyPanSpeed}
      keys={{ LEFT: 'ArrowLeft', UP: 'ArrowUp', RIGHT: 'ArrowRight', BOTTOM: 'ArrowDown' }}
    />
  );
}
