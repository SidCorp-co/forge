// Where sign-in sends the person back to: a page that needed a session (the MCP consent page, the
// chat link page) sends them to /login?next=<its path and query>, and sign-in returns there. Only a
// path on this origin is taken; anything else is read as no return at all, never followed.

const RETURN_KEY = "next";

/** The path and query `raw` names, when it is one on this origin; null for anything else. */
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return null;
  // a control character or a backslash lets a browser read the path as another origin
  if (/[\u0000-\u001f\\]/.test(raw)) return null;
  return raw;
}

/** The return path a /login URL carries, or null when it carries none this origin can take. */
export function returnPathFrom(params: URLSearchParams): string | null {
  return safeReturnPath(params.get(RETURN_KEY));
}

/** The /login href that returns to `path` after sign-in. */
export function loginHref(path: string): string {
  const back = safeReturnPath(path);
  return back ? `/login?${new URLSearchParams({ [RETURN_KEY]: back })}` : "/login";
}
