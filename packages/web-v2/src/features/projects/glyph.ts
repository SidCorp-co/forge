// Deterministic project glyph helpers — derive the `ProjectMark` initials +
// tint/ink from a project's name/id so the switcher, console, and overview all
// render the same square monogram without storing per-project branding.
import { AVATAR_HUE, type AvatarHue } from '@/design/status';

const HUES: AvatarHue[] = ['cobalt', 'flame', 'green', 'amber', 'ink'];

/** First letters of up to two words, uppercased (e.g. "Forge Dev" → "FD"). */
export function projectInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** Stable hue pick from a project key (id or slug). */
export function projectGlyph(key: string): { tint: string; ink: string } {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  const hue = AVATAR_HUE[HUES[hash % HUES.length]];
  return { tint: hue.bg, ink: hue.fg };
}
