export function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function fmtCost(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

export function localDate(): string {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

export function pct(value: number, total: number): number {
  return total > 0 ? (value / total) * 100 : 0;
}

export const MODEL_COLORS: Record<string, string> = {
  'claude-opus': '#f97316',
  'claude-sonnet': '#3b82f6',
  'claude-haiku': '#22c55e',
  gemini: '#a855f7',
  gpt: '#ec4899',
  unknown: '#94a3b8',
};

export function modelColor(model: string): string {
  const key = Object.keys(MODEL_COLORS).find((k) => model.includes(k));
  return key ? MODEL_COLORS[key] : MODEL_COLORS.unknown;
}

export const DAY_OPTIONS = [7, 14, 30, 60, 90] as const;
