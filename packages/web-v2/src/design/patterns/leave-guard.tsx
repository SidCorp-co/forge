"use client";

// A page holding unsaved edits asks before it is left. The App Router gives a page no way to veto
// a navigation, so each way out is answered by name: the browser's own prompt for a reload or a
// close, a click on a same-origin link, a navigation the app starts from code, and the Back button.

import { useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { ConfirmDialog } from "@/design/primitives/confirm-dialog";

interface Pending {
  /** Carries out the navigation the person was asked about. */
  go: () => void;
  /** The navigation is a Back that already leaves the guard's entry behind it. */
  viaBack?: boolean;
}

interface LeaveGuardApi {
  mark: (id: string, dirty: boolean) => void;
  attempt: (go: () => void) => void;
}

const SENTINEL = "__leaveGuard";

const LeaveGuardContext = createContext<LeaveGuardApi | null>(null);

/** The link a click activates, when it leads to another page of this app. */
function appLinkTarget(event: MouseEvent): HTMLAnchorElement | null {
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!anchor || anchor.hasAttribute("download")) return null;
  if (anchor.target !== "" && anchor.target !== "_self") return null;
  const to = new URL(anchor.href, window.location.href);
  if (to.origin !== window.location.origin) return null;
  if (to.pathname === window.location.pathname && to.search === window.location.search) return null;
  return anchor;
}

export function LeaveGuardProvider({ children }: { children: ReactNode }) {
  const dirtyIds = useRef(new Set<string>());
  const [anyDirty, setAnyDirty] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const bypass = useRef(false);
  const asked = useRef(false);

  const mark = useCallback((id: string, dirty: boolean) => {
    if (dirty) {
      dirtyIds.current.add(id);
      asked.current = false;
    } else dirtyIds.current.delete(id);
    setAnyDirty(dirtyIds.current.size > 0);
  }, []);

  const attempt = useCallback((go: () => void) => {
    if (dirtyIds.current.size === 0) go();
    else setPending({ go });
  }, []);

  useEffect(() => {
    if (!anyDirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      if (asked.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyDirty]);

  useEffect(() => {
    if (!anyDirty) return;
    const onClick = (event: MouseEvent) => {
      if (bypass.current) return;
      const anchor = appLinkTarget(event);
      if (!anchor) return;
      event.preventDefault();
      event.stopPropagation();
      setPending({
        go: () => {
          bypass.current = true;
          try {
            anchor.click();
          } finally {
            bypass.current = false;
          }
        },
      });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [anyDirty]);

  // While a page is dirty one history entry of the guard's own sits above it, so a press of Back
  // lands on the same page and can be answered. The entry is dropped once the page is clean, and
  // only while it is still the entry the browser is on: after a navigation it is not ours to pop.
  // One listener lives as long as the provider: the Back that drops the entry lands after the
  // page may already be clean, and it has to be consumed there or the next real Back is.
  const swallow = useRef(0);
  const sentinel = useRef<{ token: string; onIt: boolean } | null>(null);
  const afterBack = useRef<(() => void) | null>(null);
  const push = useCallback(() => {
    const armed = sentinel.current;
    if (!armed) return;
    window.history.pushState({ ...window.history.state, [SENTINEL]: armed.token }, "", window.location.href);
    armed.onIt = true;
  }, []);

  useEffect(() => {
    const onPop = () => {
      if (swallow.current > 0) {
        swallow.current -= 1;
        const next = afterBack.current;
        afterBack.current = null;
        // Next answers this popstate itself; a navigation begun inside it is overtaken by it.
        if (next) setTimeout(next, 0);
        return;
      }
      const armed = sentinel.current;
      if (!armed?.onIt) return;
      // The browser is on the page's own entry now. Put the guard's entry back at once, so a
      // second Back before the person has answered is answered too.
      push();
      setPending({
        viaBack: true,
        go: () => {
          armed.onIt = false;
          window.history.go(-2);
        },
      });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [push]);

  useEffect(() => {
    if (!anyDirty) return;
    const armed = { token: `${Date.now()}-${Math.random()}`, onIt: false };
    sentinel.current = armed;
    push();
    return () => {
      sentinel.current = null;
      if (armed.onIt && window.history.state?.[SENTINEL] === armed.token) {
        swallow.current += 1;
        window.history.back();
      }
    };
  }, [anyDirty, push]);

  // Going forward past the guard's entry would strand it between the two pages: take it off first.
  const unwind = useCallback((then: () => void) => {
    const armed = sentinel.current;
    if (!armed?.onIt || window.history.state?.[SENTINEL] !== armed.token) {
      then();
      return;
    }
    armed.onIt = false;
    swallow.current += 1;
    afterBack.current = then;
    window.history.back();
  }, []);

  const api = useMemo<LeaveGuardApi>(() => ({ mark, attempt }), [mark, attempt]);

  const stay = () => setPending(null);
  // Someone who said Leave has been asked: the browser does not ask a second time for the
  // navigation that leaves the document.
  const leave = () => {
    const leaving = pending;
    setPending(null);
    asked.current = true;
    setTimeout(() => {
      asked.current = false;
    }, 1000);
    if (leaving?.viaBack) leaving.go();
    else if (leaving) unwind(leaving.go);
  };

  return (
    <LeaveGuardContext.Provider value={api}>
      {children}
      <ConfirmDialog
        open={pending !== null}
        title="Leave without saving?"
        message="This page has changes you have not saved. If you leave now they are lost."
        confirmLabel="Leave"
        cancelLabel="Stay"
        tone="danger"
        onClose={stay}
        onConfirm={leave}
      />
    </LeaveGuardContext.Provider>
  );
}

/** Tells the guard whether this page holds unsaved edits. A page that holds edits with no guard
 *  above it would lose them silently, so that is refused by name. */
export function useUnsavedChanges(dirty: boolean): void {
  const guard = useContext(LeaveGuardContext);
  const id = useId();
  if (guard === null) {
    throw new Error(
      "useUnsavedChanges needs a <LeaveGuardProvider> above it: a page that holds unsaved edits has to be able to ask before it is left. The workspace layout mounts one.",
    );
  }
  const { mark } = guard;
  useEffect(() => {
    mark(id, dirty);
    return () => mark(id, false);
  }, [mark, id, dirty]);
}

/** Runs a navigation the app starts from code once the person has been asked, where asking is owed. */
export function useLeaveGuardAttempt(): (go: () => void) => void {
  const guard = useContext(LeaveGuardContext);
  return guard?.attempt ?? ((go) => go());
}

/** Whether a destination is the page already shown: that navigation unmounts nothing, so it
 *  is not a way out and is not asked about. */
function isThisPage(href: unknown): boolean {
  if (typeof href !== "string") return false;
  const to = new URL(href, window.location.href);
  return (
    to.origin === window.location.origin &&
    to.pathname === window.location.pathname &&
    to.search === window.location.search
  );
}

/** The router, with every push and replace asked about first while a page holds unsaved edits. */
export function useGuardedRouter() {
  const router = useRouter();
  const attempt = useLeaveGuardAttempt();
  return useMemo(
    () => ({
      ...router,
      push: (...args: Parameters<typeof router.push>) =>
        isThisPage(args[0]) ? router.push(...args) : attempt(() => router.push(...args)),
      replace: (...args: Parameters<typeof router.replace>) =>
        isThisPage(args[0]) ? router.replace(...args) : attempt(() => router.replace(...args)),
    }),
    [router, attempt],
  );
}
