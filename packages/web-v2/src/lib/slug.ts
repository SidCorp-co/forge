
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** Lowercase letters, digits, and hyphens only. */
export const SLUG_RE = /^[a-z0-9-]+$/;
