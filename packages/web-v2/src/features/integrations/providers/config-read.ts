// Reading a connection's non-secret `config` for the one-line identity on a card.
//
// cm:guard every value these return is rendered into the DOM — a key added here must be one of the
// non-secret config tier, never a credential.

/** The host of a stored URL, or null when the value is not one. */
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
