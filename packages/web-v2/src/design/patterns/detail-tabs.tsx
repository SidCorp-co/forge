
import { useCopy } from "@/lib/i18n/interface-language";
import { cn } from "@/lib/utils/cn";
import type { ReactNode } from "react";
import { createContext, use, useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useUrlChoice } from "../hooks/use-url-params";
import { Icon } from "../icons/icon";
import { Tabs } from "../primitives/tabs";

/** `?tab=` over a fixed set of views; the first is the default and is not written to the URL. */
export function useUrlTab<T extends string>(tabs: readonly T[]): [T, (t: T) => void] {
  return useUrlChoice("tab", tabs, tabs[0]);
}

interface DetailTabItem<T extends string> {
  value: T;
  label: string;
  count?: number;
}

interface DetailTabsProps<T extends string> {
  tabs: readonly DetailTabItem<T>[];
  value: T;
  onChange: (t: T) => void;
  testId?: string;
}

export function DetailTabs<T extends string>({ tabs, value, onChange, testId }: DetailTabsProps<T>) {
  const topRef = useRef<HTMLDivElement>(null);
  const go = useCallback(
    (t: string) => {
      onChange(t as T);
      const el = topRef.current;
      const floor = el?.closest("main")?.getBoundingClientRect().top ?? 0;
      if (el && el.getBoundingClientRect().top < floor) el.scrollIntoView({ block: "start" });
    },
    [onChange],
  );
  return (
    <>
      <div ref={topRef} />
      {/* the tabs wrap onto a second row where the page is too narrow for them, never scrolling sideways (REQ-31 BC-3) */}
      <div className="sticky top-0 z-10 bg-app px-6 max-md:px-2" data-testid={testId ?? "detail-tabs"}>
        <Tabs tabs={tabs.map((t) => ({ ...t }))} value={value} onChange={go} />
      </div>
    </>
  );
}

/** Where a page's own lead ends: the slot DetailLayout fills with the rail below 1024px. */
const LeadEndSlotContext = createContext<((el: HTMLElement | null) => void) | null>(null);

/**
 * Marks the end of the page's own lead: its title, its standing, its summary. Below 1024px the rail
 * stands here, whole, behind one Facts disclosure, so a reader on a phone learns what the page is
 * before its properties, and the properties do not sink under the whole page. `inset` is a mark
 * inside a padded pane; the disclosure still runs edge to edge. Outside a DetailLayout (a shared
 * page reusing a reader) it draws nothing.
 */
export function DetailLeadEnd({ inset = false }: { inset?: boolean }) {
  const register = use(LeadEndSlotContext);
  if (!register) return null;
  return <div ref={register} className={cn(inset && "-mx-8 max-md:-mx-4")} data-testid="detail-lead-end" />;
}

/** Whether the rail stands beside the content: read from the `lg` step the grid itself uses, through a
 *  probe that only that step hides, so it agrees with the CSS however the page column is narrowed. */
function useRailBeside() {
  const articleRef = useRef<HTMLElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const [beside, setBeside] = useState(false);
  useLayoutEffect(() => {
    const read = () => {
      if (probeRef.current) setBeside(getComputedStyle(probeRef.current).display === "none");
    };
    read();
    if (typeof ResizeObserver === "undefined" || !articleRef.current) return;
    const ro = new ResizeObserver(read);
    ro.observe(articleRef.current);
    return () => ro.disconnect();
  }, []);
  return { articleRef, probeRef, beside };
}

/** The rail below 1024px: one Facts row naming its groups, opening onto the whole rail. Flat, hairlines only. */
function RailFacts({ children }: { children: ReactNode }) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const id = useId();
  // the groups are named from the rail as drawn, and renamed as it redraws (a group appears with its data)
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const read = () => setGroups([...body.querySelectorAll("[data-facts-title]")].map((el) => el.textContent?.trim() ?? "").filter(Boolean).join(" · "));
    read();
    if (typeof MutationObserver === "undefined") return;
    const mo = new MutationObserver(read);
    mo.observe(body, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, []);
  return (
    <div className="border-y border-line-subtle" data-testid="rail-facts">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-8 py-3 text-left hover:bg-hover max-md:px-4"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        data-testid="rail-facts-toggle"
      >
        <span className="text-14 font-semibold text-fg">{t("common.facts")}</span>
        {groups ? <span className="min-w-0 truncate text-13 text-muted" data-testid="rail-facts-groups">{groups}</span> : null}
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} className="ml-auto flex-none text-subtle" />
      </button>
      <div id={id} ref={bodyRef} hidden={!open} className="border-t border-line-subtle">
        {children}
      </div>
    </div>
  );
}

/**
 * The page grid. From 1024px the facts rail stands beside the main column; below it the rail moves,
 * whole, to where the page marks the end of its lead (DetailLeadEnd), behind one Facts disclosure.
 * This is the one rule: no page moves or copies its own facts for a phone.
 *
 * `contentsRail` is a rail that holds no facts, only the page's contents (a ContentsList). Below
 * 1024px it is not drawn and nothing is folded: the page's own ContentsMenu stands in for it, and a
 * Facts row would open onto nothing.
 */
export function DetailLayout({
  children,
  rail,
  testId,
  dataKey,
  railCollapsed = false,
  contentsRail = false,
}: {
  children: ReactNode;
  rail: ReactNode;
  testId?: string;
  dataKey?: string;
  railCollapsed?: boolean;
  contentsRail?: boolean;
}) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const { articleRef, probeRef, beside } = useRailBeside();
  // a collapsed rail is a wide-screen choice: below 1024px the rail is offered as always
  const facts = beside || contentsRail ? null : <RailFacts>{rail}</RailFacts>;
  return (
    <LeadEndSlotContext value={setSlot}>
      <article
        ref={articleRef}
        className={cn("relative grid min-h-[calc(100dvh-48px)] bg-app", !railCollapsed && "lg:grid-cols-[minmax(0,1fr)_320px]")}
        data-testid={testId}
        data-key={dataKey}
        data-rail={railCollapsed ? "collapsed" : "open"}
        data-rail-place={beside ? "beside" : "lead"}
      >
        <span ref={probeRef} aria-hidden className="absolute size-0 lg:hidden" data-testid="rail-probe" />
        <div className="min-w-0">
          {children}
          {/* a page that marks no lead still gets its rail whole, after its content */}
          {facts && !slot ? facts : null}
        </div>
        {beside && !railCollapsed ? rail : null}
      </article>
      {facts && slot ? createPortal(facts, slot) : null}
    </LeadEndSlotContext>
  );
}

/** A tab's view: the main column's full width up to the rail, under the tabs. No cap of its own: a
 *  capped pane left a blank band between the content and the rail on a wide screen. */
export function DetailPane({ children, label, testId }: { children: ReactNode; label: string; testId?: string }) {
  return (
    <section className="px-8 pb-16 pt-6 max-md:px-4" aria-label={label} data-testid={testId}>
      {children}
    </section>
  );
}

/** A heading inside a view: primary colour, 15/600, so it can never be mistaken for a label; an
 *  optional act or state sits at its right. Flat: a heading and its content, never a card. It takes
 *  no explaining line: a section the reader needs told about is a section to change (REQ-43 BC-4). */
export function ViewHeading({ children, right, id }: { children: ReactNode; right?: ReactNode; id?: string }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
      <h2 id={id} className="text-16 font-bold leading-snug text-accent-text">
        {children}
      </h2>
      {right ? <div className="ml-auto flex items-center gap-2">{right}</div> : null}
    </div>
  );
}

/** A label above a group of values: secondary, but readable (WCAG AA on every ground it sits on). */
export function FieldLabel({ children }: { children: ReactNode }) {
  return <h3 className="mb-1.5 text-12-5 font-medium text-muted">{children}</h3>;
}
