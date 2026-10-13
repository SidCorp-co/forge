// A stand-in for the app's navigation (src/lib/navigation/router.tsx) in a test that renders a
// screen without a router: `vi.mock("@/lib/navigation/router", () => navigationDouble({ … }))`.
// What a test does not override reads and moves jsdom's own location, so a test that sets
// `window.history` first opens the screen there. A test of the routes themselves mounts the real
// router instead (src/test/route-tree.tsx).
import { type AnchorHTMLAttributes, type MouseEvent, type Ref, useSyncExternalStore } from "react";
import type * as Navigation from "@/lib/navigation/router";

type AppRouter = ReturnType<typeof Navigation.useRouter>;

interface Overrides {
  /** The verbs a test watches; any it leaves out move jsdom's location. */
  useRouter?: () => Partial<AppRouter>;
  usePathname?: () => string;
  useSearchParams?: () => URLSearchParams;
  useParams?: () => Record<string, string>;
}

const listeners = new Set<() => void>();
const moved = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
};

const go = (href: string, replace: boolean) => {
  if (replace) window.history.replaceState(window.history.state, "", href);
  else window.history.pushState(window.history.state, "", href);
  moved();
};

const jsdomRouter: AppRouter = {
  push: (href) => go(href, false),
  replace: (href) => go(href, true),
  back: () => window.history.back(),
  refresh: () => {},
};

/** Hrefs are shown as given: a test renders under no basepath. */
const asGiven = (href: string) => href;

const SCHEME = /^[a-z][a-z\d+.-]*:|^\/\//i;

interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  href: string;
  replace?: boolean;
  scroll?: boolean;
  ref?: Ref<HTMLAnchorElement>;
}

export function navigationDouble(overrides: Overrides = {}): typeof Navigation {
  const useRouter = (): AppRouter => ({ ...jsdomRouter, ...overrides.useRouter?.() });
  const usePathname =
    overrides.usePathname ?? (() => useSyncExternalStore(subscribe, () => window.location.pathname));
  const useSearchParams =
    overrides.useSearchParams ??
    (() => new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search)));
  const useParams = (overrides.useParams ?? (() => ({}))) as typeof Navigation.useParams;

  function Link({ href, replace, scroll: _scroll, onClick, target, children, ...rest }: LinkProps) {
    const router = useRouter();
    const follow = (event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      const elsewhere = event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
      if (elsewhere || (target !== undefined && target !== "_self") || SCHEME.test(href)) return;
      event.preventDefault();
      if (replace) router.replace(href);
      else router.push(href);
    };
    return (
      <a {...rest} target={target} href={href} onClick={follow}>
        {children}
      </a>
    );
  }

  return { Link, useBasedHref: asGiven, useRouter, usePathname, useSearchParams, useParams };
}
