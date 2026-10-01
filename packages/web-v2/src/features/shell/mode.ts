import { ECOSYSTEM_ITEMS, PROJECT_ITEMS_BY_SPECIFICITY, activeSlug, matchesSub } from "./nav-model";

export type ShellMode = "activity" | "chat";

export const CHAT_ROOT = "/chat";

export function modeOf(pathname: string): ShellMode {
  return pathname === CHAT_ROOT || pathname.startsWith(`${CHAT_ROOT}/`) ? "chat" : "activity";
}

export function chatSlug(pathname: string): string | null {
  const m = pathname.match(/^\/chat\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1] as string) : null;
}

export function chatConversationId(pathname: string): string | null {
  const m = pathname.match(/^\/chat\/[^/?#]+\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1] as string) : null;
}

export function chatPath(slug?: string | null, conversationId?: string | null): string {
  if (!slug) return CHAT_ROOT;
  const base = `${CHAT_ROOT}/${encodeURIComponent(slug)}`;
  return conversationId ? `${base}/${encodeURIComponent(conversationId)}` : base;
}

export function routeSlug(pathname: string): string | null {
  return modeOf(pathname) === "chat" ? chatSlug(pathname) : activeSlug(pathname);
}

const pathOf = (route: string) => route.split(/[?#]/)[0] ?? route;

function projectSub(pathname: string, slug: string): string {
  const rest = pathname.slice(`/projects/${slug}`.length);
  const subs = [...ECOSYSTEM_ITEMS, ...PROJECT_ITEMS_BY_SPECIFICITY].map((it) => it.sub);
  return subs.find((sub) => matchesSub(rest, sub)) ?? "";
}

// cm:why a remembered route in another project keeps its page kind and drops the record it had open, since that record belongs to the other project; switching modes never changes which project is selected
export function switchTarget(to: ShellMode, remembered: string | null, slug: string | null): string {
  const last = remembered && modeOf(pathOf(remembered)) === to ? remembered : null;
  if (to === "chat") {
    if (!last) return chatPath(slug);
    const was = chatSlug(pathOf(last));
    return !slug || was === slug ? last : chatPath(slug);
  }
  if (!last) return slug ? `/projects/${slug}` : "/";
  const was = activeSlug(pathOf(last));
  if (!was || !slug || was === slug) return last;
  return `/projects/${slug}${projectSub(pathOf(last), was)}`;
}

export type ModeRoutes = Record<ShellMode, string | null>;

export const NO_MODE_ROUTES: ModeRoutes = { activity: null, chat: null };

export function rememberRoute(routes: ModeRoutes, route: string): ModeRoutes {
  const mode = modeOf(pathOf(route));
  return routes[mode] === route ? routes : { ...routes, [mode]: route };
}
