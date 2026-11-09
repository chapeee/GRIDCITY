/**
 * Per-frame values of the jack-in transition, written by the camera tween and
 * read by post-processing every frame. A plain mutable object on purpose:
 * these change 60 times a second and must not trigger React renders.
 */
export const transitionEffect = {
  /** Chromatic aberration strength, 0..1. Only ever non-zero during a dive. */
  aberration: 0,
};
