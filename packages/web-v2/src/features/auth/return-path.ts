// Where a signed-out visit comes back to after sign-in. The address travels in the login URL, so it
// is input from anyone who can send a link: only a page on this site is followed, the rest refused by name.

export const RETURN_PARAM = 'next';

const MAX_LENGTH = 2048;

const ORIGIN = 'http://return-path.invalid';

function hasControlCharacter(text: string): boolean {
  return Array.from(text).some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
}

export type ReturnPath =
  | { kind: 'none' }
  | { kind: 'path'; path: string }
  | { kind: 'refused'; why: string };

function refuse(why: string): ReturnPath {
  return { kind: 'refused', why };
}

export function readReturnPath(raw: string | string[] | null | undefined): ReturnPath {
  if (raw === undefined || raw === null || raw === '') return { kind: 'none' };
  if (Array.isArray(raw)) return refuse(`${RETURN_PARAM} was given ${raw.length} times and names no one page`);
  if (raw.length > MAX_LENGTH) return refuse(`it is longer than ${MAX_LENGTH} characters`);
  if (hasControlCharacter(raw)) return refuse('it contains a control character');
  if (raw.includes('\\')) return refuse('it contains a backslash, which browsers read as a slash');
  if (!raw.startsWith('/')) return refuse('it is not a path on this site, which starts with "/"');
  if (raw.startsWith('//')) return refuse('it starts with "//", which names another site');

  let url: URL;
  try {
    url = new URL(raw, ORIGIN);
  } catch {
    return refuse('it is not a valid address');
  }
  // Dot segments resolve during parsing, so "/.//host" becomes "//host" only here.
  const path = `${url.pathname}${url.search}${url.hash}`;
  if (url.origin !== ORIGIN || path.startsWith('//')) return refuse('it resolves to another site');
  return { kind: 'path', path };
}

/** The login URL a signed-out visit to `from` is sent to; the dashboard needs no return address. */
export function loginHref(from: string): string {
  const read = readReturnPath(from);
  if (read.kind !== 'path' || read.path === '/') return '/login';
  return `/login?${new URLSearchParams({ [RETURN_PARAM]: read.path }).toString()}`;
}

/** Where a signed-in person on an auth page goes: the URL's return address if it is followed, else `/`. */
export function returnPathFromSearch(search: string): string {
  const given = new URLSearchParams(search).getAll(RETURN_PARAM);
  const read = readReturnPath(given.length > 1 ? given : given[0]);
  return read.kind === 'path' ? read.path : '/';
}
