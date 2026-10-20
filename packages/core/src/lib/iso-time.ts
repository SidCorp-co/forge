/** ISO 8601 from a `Date` or the Postgres text a raw read answers (`2026-10-20 04:15:53.658+00`). */
export function isoOrNull(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const at = new Date(value.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));
  if (Number.isNaN(at.getTime())) throw new Error(`"${value}" is not a timestamp`);
  return at.toISOString();
}

export function isoOf(value: Date | string): string {
  return isoOrNull(value) as string;
}
