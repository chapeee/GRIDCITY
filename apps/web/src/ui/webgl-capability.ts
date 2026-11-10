/** Software rasterizers: WebGL "works" on them, but slower than plain DOM rendering. */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|microsoft basic render/i;

let cached: boolean | undefined;

/**
 * True when WebGL runs on a real GPU. On software rasterizers (VMs, remote
 * desktops, CI) the terminal uses xterm's DOM renderer instead, which is far
 * faster there. Checked once per page.
 */
export function hasHardwareWebGL(): boolean {
  if (cached !== undefined) return cached;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return (cached = false);
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(
      info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    );
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return (cached = !SOFTWARE_RENDERER.test(renderer));
  } catch {
    return (cached = false);
  }
}
