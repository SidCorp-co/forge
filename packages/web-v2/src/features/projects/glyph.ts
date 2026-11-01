import { initialsOf } from '@/design/initials';
import { AVATAR_HUE, type AvatarHue } from '@/design/status';

const HUES: AvatarHue[] = ['cobalt', 'flame', 'green', 'amber', 'ink'];

/** First letters of up to two words, letters only (e.g. "Forge Dev" → "FD", "Epod (ops)" → "EO"). */
export function projectInitials(name: string): string {
  return initialsOf(name);
}

/** Stable hue pick from a project key (id or slug). */
export function projectGlyph(key: string): { tint: string; ink: string } {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  const hue = AVATAR_HUE[HUES[hash % HUES.length]];
  return { tint: hue.bg, ink: hue.fg };
}
