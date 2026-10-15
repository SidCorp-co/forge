// The peek beside a list (`?peek=KEY`): a summary of one row — its header, whose turn it is, what it
// says and the facts that decide it — with "Open full page ↗", ↑/↓ and j/k through the visible rows,
// Esc to close. The URL holds which row is open, written with replaceState, so opening, closing and
// moving never stack history entries and back from the full page reopens the same peek. The full page
// is a link (a modified click opens it in a new tab), the title is the same link, and its code loads
// as the peek opens, so the click finds it ready. From 1024px it sits beside the list and the list
// stays live; below that it is a full-screen sheet named after the list.

import type { ReactNode } from "react";
import { createContext, use, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, usePreload, useRouter } from "@/lib/navigation/router";
import { cn } from "@/lib/utils/cn";
import { buttonVariants } from "@/components/ui/button";
import { IconButton } from "../primitives/icon-button";
import { Button } from "../primitives/button";
import { Kbd } from "../primitives/kbd";
import { useUrlParams } from "../hooks/use-url-params";
import { useCopy } from "@/lib/i18n/interface-language";
import { rememberListOrigin } from "./detail-header";

export interface PeekState {
  /** The open row's key, when it is one of `keys`. */
  open: string | null;
  /** 1-based position among the visible rows, or null when the open row is folded away. */
  position: { at: number; of: number } | null;
  set: (key: string | null) => void;
  move: (by: number) => void;
}

/** `?peek=` over the rows the reader can see, in their visible order. */
export function usePeek(keys: readonly string[], allKeys: readonly string[] = keys): PeekState {
  const [params, setParams] = useUrlParams();
  const raw = params.get("peek");
  const open = raw && allKeys.includes(raw) ? raw : null;
  const set = useCallback((key: string | null) => setParams({ peek: key }), [setParams]);
  const at = open ? keys.indexOf(open) : -1;
  const move = useCallback(
    (by: number) => {
      const i = open ? keys.indexOf(open) : -1;
      const next = i < 0 ? keys[0] : keys[i + by];
      if (next) setParams({ peek: next });
    },
    [keys, open, setParams],
  );
  return { open, position: at >= 0 ? { at: at + 1, of: keys.length } : null, set, move };
}

/** The open row's full page, and the list its back control returns to (null where there is none). */
export interface FullPage {
  href: string;
  origin: string | null;
}

/** Goes to the full page from an act inside the peek that is not its link (a primary that is done there). */
export function useOpenFullPage(full: FullPage): () => void {
  const router = useRouter();
  return () => {
    if (full.origin) rememberListOrigin(full.origin);
    router.push(full.href);
  };
}

/** j/k (and ↓/↑) move, Enter opens the full page, Esc closes — never while typing in a field. Enter
 *  on the list row the click left focused opens the full page too; the row's own click would close
 *  the peek it opened. */
export function usePeekKeys(peek: PeekState, onOpenFull: (key: string) => void): void {
  useEffect(() => {
    if (!peek.open) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") peek.set(null);
      else if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        peek.move(1);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        peek.move(-1);
      } else if (e.key === "Enter" && (e.target === document.body || el?.dataset.peekRoot === "1" || el?.dataset.testid === "list-row")) {
        e.preventDefault();
        onOpenFull(peek.open as string);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [peek, onOpenFull]);
}

interface PeekPanelProps {
  peek: PeekState;
  /** The list's name, on the back control of the narrow-screen sheet: "← Issues". */
  listLabel: string;
  /** What kind of item this is, before its key: "Issue", "Requirement", "Feedback". */
  noun: string;
  full: FullPage;
  children: ReactNode;
  testId?: string;
}

const FullPageContext = createContext<FullPage | null>(null);

function FullPageLink({ full, className, children, testId }: { full: FullPage; className?: string; children: ReactNode; testId?: string }) {
  return (
    <Link href={full.href} className={className} data-testid={testId} onClick={() => (full.origin ? rememberListOrigin(full.origin) : undefined)}>
      {children}
    </Link>
  );
}

export function PeekPanel({ peek, listLabel, noun, full, children, testId }: PeekPanelProps) {
  const pos = peek.position;
  const t = useCopy();
  const preload = usePreload();
  useEffect(() => preload(full.href), [preload, full.href]);
  return (
    <aside
      className="fixed inset-0 z-30 flex flex-col overflow-y-auto border-line-subtle bg-surface lg:sticky lg:inset-auto lg:top-0 lg:z-auto lg:h-[calc(100dvh-48px)] lg:border-l"
      aria-label={t("common.peekSummary", { noun, key: peek.open ?? "" })}
      data-testid={testId ?? "peek-panel"}
      data-peek-root="1"
    >
      <div className="sticky top-0 z-[3] flex items-center gap-1.5 border-b border-line-subtle bg-surface px-3 py-2">
        <Button type="button" size="sm" className="lg:hidden" onClick={() => peek.set(null)} data-testid="peek-back">
          ← {listLabel}
        </Button>
        <IconButton icon="arrowUp" size="sm" aria-label={t("common.peekPrevious", { noun: noun.toLowerCase() })} disabled={!pos || pos.at <= 1} onClick={() => peek.move(-1)} />
        <IconButton icon="arrowDown" size="sm" aria-label={t("common.peekNext", { noun: noun.toLowerCase() })} disabled={!pos || pos.at >= pos.of} onClick={() => peek.move(1)} />
        {pos ? (
          <span className="mx-1 whitespace-nowrap font-mono text-11 text-subtle" data-testid="peek-position">
            {t("common.peekPosition", { at: pos.at, of: pos.of })}
          </span>
        ) : null}
        <span className="flex-1" />
        <FullPageLink full={full} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "no-underline")} testId="open-full-page">
          {t("common.openFullPage")}
        </FullPageLink>
        <IconButton icon="x" size="sm" aria-label={t("common.peekClose")} onClick={() => peek.set(null)} />
      </div>
      <FullPageContext value={full}>
        <div className="flex flex-1 shrink-0 flex-col">{children}</div>
      </FullPageContext>
      <div className="mt-auto border-t border-line-subtle px-[18px] pb-4 pt-2.5 text-12 text-subtle max-lg:hidden">
        <Kbd>j</Kbd> <Kbd>k</Kbd> {t("common.peekMove")} · <Kbd>{t("common.key.enter")}</Kbd> {t("common.peekFullPage")} · <Kbd>{t("common.key.escape")}</Kbd> {t("common.peekCloseWord")}
      </div>
    </aside>
  );
}

interface PeekHeadProps {
  noun: string;
  itemKey: string;
  badge?: ReactNode;
  title: ReactNode;
  /** The one primary act, the same the full page's header offers. */
  action?: ReactNode;
}

/** The peek's header: kind, key and state, the title (a link to the full page), and the one primary act. */
export function PeekHead({ noun, itemKey, badge, title, action }: PeekHeadProps) {
  const full = use(FullPageContext);
  if (!full) throw new Error("PeekHead is drawn outside a PeekPanel, so its title has no full page to link to");
  return (
    <div className="px-[18px] pb-3 pt-3.5" data-testid="peek-head">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-12 text-subtle">{noun}</span>
        <span className="font-mono text-12 font-semibold text-link">{itemKey}</span>
        {badge}
      </div>
      <h2 className="mt-1.5 text-[17px] font-semibold leading-snug text-fg">
        <FullPageLink full={full} className="text-fg no-underline hover:underline" testId="peek-title-link">
          {title}
        </FullPageLink>
      </h2>
      {action ? <div className="mt-2.5 flex flex-wrap gap-2 empty:hidden">{action}</div> : null}
    </div>
  );
}

/** What the item says, held to about a dozen lines with "Show all" opening the rest in place, so
 *  reading it does not take the full page. Text that fits shows whole and offers nothing. */
export function PeekExcerpt({ children, testId }: { children: ReactNode; testId?: string }) {
  const t = useCopy();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [open]);
  return (
    <div data-testid={testId ?? "peek-excerpt"}>
      <div ref={ref} className={cn("min-w-0 text-13-5", !open && "max-h-60 overflow-hidden")} data-clamped={open ? undefined : "1"}>
        {children}
      </div>
      {overflows ? (
        <button type="button" className="mt-1.5 text-13 font-medium text-link hover:underline" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="peek-excerpt-toggle">
          {open ? t("common.peekShowLess") : t("common.peekShowAll")}
        </button>
      ) : null}
    </div>
  );
}
