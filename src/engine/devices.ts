/** Built-in short names (spec §5 rule 6). Any other name matches by case-insensitive substring. */
export const SHORT_NAMES: Readonly<Record<string, RegExp>> = {
  op1: /OP-1/i,
  apc: /APC MINI/i,
  webcam: /Logitech|BRIO|C9\d\d|Webcam/i,
  laptopcam: /FaceTime|MacBook.*Camera/i,
  laptopmic: /MacBook.*Microphone/i,
};

/** Virtual, meeting and Continuity devices: hidden from pickers and never auto-matched. */
const HIDDEN = /zoom|teams|continuity|iphone|\bphone\b/i;

export const isHidden = (label: string): boolean => HIDDEN.test(label);

export function matchesName(name: string, label: string): boolean {
  if (!name || !label) return false;
  const re = SHORT_NAMES[name.toLowerCase()];
  return re ? re.test(label) : label.toLowerCase().includes(name.toLowerCase());
}

export function shortNameFor(label: string): string | null {
  for (const [name, re] of Object.entries(SHORT_NAMES)) if (re.test(label)) return name;
  return null;
}

/** The first non-hidden candidate whose label matches `name`. */
export function findByName<T extends { label: string }>(name: string, candidates: readonly T[]): T | undefined {
  return candidates.find((c) => !isHidden(c.label) && matchesName(name, c.label));
}
