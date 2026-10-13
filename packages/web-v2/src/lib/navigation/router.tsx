// The app's navigation over TanStack Router, in the shape the screens use: a Link that takes an
// in-app href (path, search and hash in one string), and the hooks a screen reads its place with.
// An href is in-app (no basepath); the router adds the basepath to what the browser shows.

import {
  useLocation,
  useNavigate,
  useParams as useRouteParams,
  useRouter as useAppRouter,
} from "@tanstack/react-router";
import { type AnchorHTMLAttributes, type MouseEvent, type Ref, useMemo } from "react";

const SCHEME = /^[a-z][a-z\d+.-]*:|^\/\//i;

/** The href the browser shows for an in-app href: the router's basepath in front of a path. */
export function useBasedHref(href: string): string {
  const base = (useAppRouter().options.basepath ?? "").replace(/\/+$/, "");
  return base && href.startsWith("/") && !href.startsWith("//") ? `${base}${href}` : href;
}

interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  href: string;
  /** Replace the history entry instead of adding one. */
  replace?: boolean;
  /** Leave the scroll position where it is. */
  scroll?: boolean;
  ref?: Ref<HTMLAnchorElement>;
}

function opensElsewhere(event: MouseEvent<HTMLAnchorElement>, target: string | undefined): boolean {
  return (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    (target !== undefined && target !== "_self")
  );
}

/** A link inside the app, followed by the router; a modified click or an outside href is the browser's. */
export function Link({ href, replace, scroll, onClick, target, children, ...rest }: LinkProps) {
  const navigate = useNavigate();
  const shown = useBasedHref(href);
  return (
    <a
      {...rest}
      target={target}
      href={shown}
      onClick={(event) => {
        onClick?.(event);
        if (opensElsewhere(event, target) || SCHEME.test(href)) return;
        event.preventDefault();
        void navigate({ href, replace: replace ?? false, resetScroll: scroll !== false });
      }}
    >
      {children}
    </a>
  );
}

interface NavigateOptions {
  scroll?: boolean;
}

/** Moves between in-app hrefs: push adds a history entry, replace swaps it, refresh reloads the data. */
export function useRouter() {
  const navigate = useNavigate();
  const router = useAppRouter();
  return useMemo(
    () => ({
      push: (href: string, options?: NavigateOptions): void => {
        void navigate({ href, resetScroll: options?.scroll !== false });
      },
      replace: (href: string, options?: NavigateOptions): void => {
        void navigate({ href, replace: true, resetScroll: options?.scroll !== false });
      },
      back: (): void => window.history.back(),
      refresh: (): void => {
        void router.invalidate();
      },
    }),
    [navigate, router],
  );
}

/** The current in-app path, without the basepath. */
export function usePathname(): string {
  return useLocation({ select: (location) => location.pathname });
}

/** The current query string as URLSearchParams. */
export function useSearchParams(): URLSearchParams {
  const searchStr = useLocation({ select: (location) => location.searchStr });
  return useMemo(() => new URLSearchParams(searchStr), [searchStr]);
}

/** The current route's path params, by the names the route file gives them. */
export function useParams<T extends Record<string, string>>(): T {
  const params = useRouteParams({ strict: false });
  return params as T;
}
