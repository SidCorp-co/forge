// Environment label — set NEXT_PUBLIC_ENV_LABEL=staging|preview|local at build time
// to surface a banner + title suffix. Empty / undefined → no banner (production default).

export const ENV_LABEL = (process.env.NEXT_PUBLIC_ENV_LABEL ?? '').trim().toUpperCase();

export const HAS_ENV_LABEL = ENV_LABEL.length > 0;

export const ENV_LABEL_TONE: Record<string, string> = {
  STAGING: 'bg-amber-500/90 text-black',
  PREVIEW: 'bg-blue-500/90 text-white',
  LOCAL: 'bg-zinc-700 text-white',
};

export function envLabelClasses(): string {
  return ENV_LABEL_TONE[ENV_LABEL] ?? 'bg-amber-500/90 text-black';
}
