export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const CHROMATIC = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

/**
 * A note group: semitone steps within an octave, and how many octaves it spans (plus the top root).
 * `random` groups play random pitches from the span, sorted to follow the swing, instead of consecutive steps.
 */
export interface Scale { readonly steps: readonly number[]; readonly octaves: number; readonly random?: boolean }

export const SCALES: Record<string, Scale> = {
  'Major pentatonic (1 oct)': { steps: [0, 2, 4, 7, 9], octaves: 1 },
  'Minor pentatonic (1 oct)': { steps: [0, 3, 5, 7, 10], octaves: 1 },
  'Major (1 oct)': { steps: [0, 2, 4, 5, 7, 9, 11], octaves: 1 },
  'Natural minor (1 oct)': { steps: [0, 2, 3, 5, 7, 8, 10], octaves: 1 },
  'Octatonic, whole-half (1 oct)': { steps: [0, 2, 3, 5, 6, 8, 9, 11], octaves: 1 },
  'Whole tone (1 oct)': { steps: [0, 2, 4, 6, 8, 10], octaves: 1 },
  'Min/maj, no 5th: 1 b3 maj7 (1 oct)': { steps: [0, 3, 11], octaves: 1 },
  'Chromatic (1 oct)': { steps: CHROMATIC, octaves: 1 },
  'Random within 1 oct': { steps: CHROMATIC, octaves: 1, random: true },
  'Random within 2 oct': { steps: CHROMATIC, octaves: 2, random: true },
};
export const SCALE_NAMES = Object.keys(SCALES);

/** MIDI note → name, middle C = C4. */
export const noteName = (n: number): string => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
export const randInt = (lo: number, hi: number): number => lo + Math.floor(Math.random() * (hi - lo + 1));

/** `n` random picks from `pool`: distinct while they last, then repeats. */
function sample(pool: readonly number[], n: number): number[] {
  const a = [...pool], out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i < a.length) {
      const j = randInt(i, a.length - 1);
      [a[i], a[j]] = [a[j], a[i]];
      out.push(a[i]);
    } else {
      out.push(pool[randInt(0, pool.length - 1)]);
    }
  }
  return out;
}

/**
 * `count` MIDI notes on `root`: consecutive scale steps starting lower-middle going up or upper-middle
 * going down (or on the root / the root an octave up). Random scales pick pitches from their span and
 * sort them the same way. Strings longer than the group carry on into the next octaves.
 */
export function makeNotes(sc: Scale, dir: 'up' | 'down', count: number, root: number, startOnRoot: boolean): number[] {
  const len = sc.steps.length, top = len * sc.octaves;
  const up = dir === 'up';
  const pitch = (i: number): number => {
    const o = Math.floor(i / len);
    return Math.min(127, Math.max(0, root + 12 * o + sc.steps[i - o * len]));
  };
  if (sc.random) {
    const first = startOnRoot ? [up ? 0 : top] : [];
    const pool = Array.from({ length: top + 1 }, (_, i) => i).filter((i) => !first.includes(i));
    const picks = sample(pool, count - first.length).sort((a, b) => (up ? a - b : b - a));
    return [...first, ...picks].map(pitch);
  }
  const half = top / 2;
  const start = startOnRoot ? (up ? 0 : top) : up ? randInt(0, Math.floor(half)) : randInt(Math.ceil(half), top);
  return Array.from({ length: count }, (_, k) => pitch(start + (up ? k : -k)));
}
