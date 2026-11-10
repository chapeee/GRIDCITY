import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
// gifenc ships CommonJS without types.
// @ts-expect-error no type declarations
import gifenc from 'gifenc';

/**
 * Records the README media: docs/media/demo.gif and stills. Not part of the
 * normal test run (it only runs with RECORD_MEDIA=1):
 *
 *   npm run media
 *
 * Uses the in-browser demo fleet, so the GIF always shows the DEMO DATA badge.
 */
test.skip(!process.env.RECORD_MEDIA, 'set RECORD_MEDIA=1 (npm run media) to record README media');

const WIDTH = 960;
const HEIGHT = 600;
const { GIFEncoder, quantize, applyPalette } = gifenc as {
  GIFEncoder: () => {
    writeFrame(index: Uint8Array, w: number, h: number, options: object): void;
    finish(): void;
    bytes(): Uint8Array;
  };
  quantize(rgba: Uint8Array, colors: number): number[][];
  applyPalette(rgba: Uint8Array, palette: number[][]): Uint8Array;
};

test('record README demo GIF', async ({ page }) => {
  test.setTimeout(180_000);
  mkdirSync('docs/media', { recursive: true });
  await page.addInitScript(() => localStorage.setItem('preferences:intro-seen', 'true'));
  await page.setViewportSize({ width: WIDTH, height: HEIGHT });
  await page.goto('/?source=demo&poll=700');
  await expect(page.locator('html[data-world-ready="true"]')).toHaveCount(1, { timeout: 60_000 });
  await page.keyboard.press('`'); // hide the dev perf overlay for the recording
  await page.waitForTimeout(3000);

  const frames: { rgba: Uint8Array; delay: number }[] = [];
  const capture = async (count: number, delay = 90) => {
    for (let index = 0; index < count; index++) {
      const png = PNG.sync.read(await page.screenshot());
      frames.push({ rgba: new Uint8Array(png.data), delay });
    }
  };

  await capture(12); // overview, live pulses and particles
  await page.keyboard.press('Control+k');
  await page.keyboard.type('api-01', { delay: 60 });
  await capture(4);
  await page.keyboard.press('Enter');
  await capture(18); // fly to the degraded host, HUD unfolds
  await page.keyboard.press('Tab');
  await capture(14); // jump to the next host
  await page.keyboard.press('Enter');
  await capture(8, 60); // the dive
  await capture(6);
  await page.keyboard.press('Control+Shift+X');
  await capture(10); // surfacing back to the city

  // One shared palette from a sample of frames keeps colors stable and the file small.
  // Sample every 16th pixel of every 3rd frame.
  const sampled: number[] = [];
  frames.forEach((frame, frameIndex) => {
    if (frameIndex % 3 !== 0) return;
    for (let pixel = 0; pixel < frame.rgba.length; pixel += 4 * 16) {
      sampled.push(frame.rgba[pixel]!, frame.rgba[pixel + 1]!, frame.rgba[pixel + 2]!, 255);
    }
  });
  const palette = quantize(new Uint8Array(sampled), 256);
  const encoder = GIFEncoder();
  frames.forEach((frame, index) => {
    encoder.writeFrame(applyPalette(frame.rgba, palette), WIDTH, HEIGHT, {
      palette: index === 0 ? palette : undefined,
      delay: frame.delay,
    });
  });
  encoder.finish();
  writeFileSync('docs/media/demo.gif', encoder.bytes());
});
