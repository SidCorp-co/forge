/** The project slug a URL sits under (`/projects/<slug>/…`), or null where it names none. */
export const projectSlugOf = (path: string | null): string | null => path?.match(/^\/projects\/([^/?#]+)/)?.[1] ?? null;
