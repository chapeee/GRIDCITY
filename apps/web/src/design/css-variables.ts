import { accents, durations, neutrals } from './tokens';

const kebab = (name: string) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/**
 * Publishes the design tokens as CSS custom properties on <html>, so the 2D
 * layer uses exactly the same values as the 3D world (tokens.ts stays the
 * single source of truth; no colors are duplicated in CSS).
 *
 * e.g. neutrals.textBright -> --color-text-bright, accents.online -> --color-online
 */
export function applyDesignTokensToCss(root: HTMLElement = document.documentElement): void {
  for (const [name, value] of Object.entries({ ...neutrals, ...accents })) {
    root.style.setProperty(`--color-${kebab(name)}`, value);
  }
  for (const [name, value] of Object.entries(durations)) {
    root.style.setProperty(`--duration-${kebab(name)}`, `${value}ms`);
  }
}
