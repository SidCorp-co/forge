
export function urlHost(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

/** A non-empty string at `key`, or null. */
export function text(config: Record<string, unknown>, key: string): string | null {
  const value = config[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
