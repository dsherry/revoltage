import { hsvToRgb } from './util';
import type { ApcColor } from './types';

/** 16 colors for APC pad rows: 15 hues and white. */
export const APC_PALETTE: readonly string[] = Array.from({ length: 16 }, (_, i) => {
  if (i === 15) return '#ffffff';
  const [r, g, b] = hsvToRgb(i / 15, 0.85, 1);
  return '#' + [r, g, b].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
});

/**
 * Three colors (slots 0–2) each own two pad rows: rows 3–4, 5–6 and 7–8 counted from the top
 * (y = 0 is the bottom row). The LED color marks which pad is selected.
 */
const COLOR_ROWS = [
  { slot: 0, top: 5, led: 'green' },
  { slot: 1, top: 3, led: 'red' },
  { slot: 2, top: 1, led: 'yellow' },
] as const;

/** Which color slot and palette index a pad picks, or null if it isn't a color pad. */
export function apcColorPad(x: number, y: number): { slot: 0 | 1 | 2; led: ApcColor; index: number } | null {
  const row = COLOR_ROWS.find((c) => y === c.top || y === c.top - 1);
  return row ? { slot: row.slot, led: row.led, index: (row.top - y) * 8 + x } : null;
}
