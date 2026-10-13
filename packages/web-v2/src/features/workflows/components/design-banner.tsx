
import { type ReactNode, type RefObject, useId, useSyncExternalStore } from "react";
import { type BannerTone, Button, bannerColours, Icon, fixedHeight } from "@/design";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { saidView } from "@/lib/i18n/said";
import { cn } from "@/lib/utils/cn";
import type { WorkflowDesign } from "../types";

const TONE: Record<WorkflowDesign["waitingOn"]["kind"], BannerTone> = {
  you: "you",
  person: "calm",
  agent: "agent",
  none: "calm",
};

interface DesignBannerProps {
  d: WorkflowDesign;
  /** The decision's acts, on the line itself: approve with a note, return with a reason. */
  acts?: ReactNode;
  /** What "Show details" opens, under the return reason: why Approve is off, what approving leaves stale, the traces it orphans. */
  detail?: ReactNode;
  /** A refusal of the last decision: always shown, never folded away. */
  alert?: ReactNode;
  open: boolean;
  onOpen: (open: boolean) => void;
  /** The canvas has no room for the detail in the flow, so it opens over the canvas instead of pushing it down. */
  float: boolean;
  detailRef: RefObject<HTMLDivElement | null>;
}

/**
 * Whom the design waits on, as one tinted line: what is owed, and the acts that answer it inline. Who
 * drew it and when is the rail's Drawn by and Updated, said once (REQ-43 BC-5). The longer reading (the
 * return reason, why Approve is off, what approving leaves stale) folds under "Show details", which
 * appears only when there is something to show.
 */
export function DesignBanner({ d, acts, detail, alert, open, onOpen, float, detailRef }: DesignBannerProps) {
  const t = useCopy();
  const w = saidView(d.waitingOn, useInterfaceLanguage());
  const id = useId();
  // The detail's parts each decide for themselves whether they have anything to say, so the toggle reads the rendered detail
  const hasDetail = useSyncExternalStore(
    (onChange) => {
      const el = detailRef.current;
      if (!el) return () => {};
      const watch = new MutationObserver(onChange);
      watch.observe(el, { childList: true });
      return () => watch.disconnect();
    },
    () => (detailRef.current?.childElementCount ?? 0) > 0,
    () => false,
  );
  if (w.kind === "none") return null;
  const c = bannerColours(TONE[w.kind]);
  const head = w.kind === "you" ? t("workflows.waitingOnYou") : t("workflows.waitingOn", { who: w.who });
  const latest = d.revisions[0];
  const reason = latest && d.status === "returned" && latest.reason ? latest.reason : null;
  const shown = open && hasDetail;
  // Floating over the canvas, the tint is laid on the surface so no node shows through it
  const overCanvas = { backgroundColor: "var(--bg-surface)", backgroundImage: `linear-gradient(${c.bg}, ${c.bg})` };
  return (
    <div className="relative text-13" data-testid="design-banner" data-open={shown} data-float={float}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-6 py-2 max-md:px-4" style={{ background: c.bg }}>
        <span aria-hidden className="size-2 flex-none rounded-pill" style={{ background: c.dot }} />
        <span className="min-w-0 flex-1 truncate" title={w.rule} data-testid="design-banner-line">
          <span className="font-bold">{head}</span> {w.act}
        </span>
        {acts ? <span className="contents">{acts}</span> : null}
        {hasDetail ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-auto w-fit flex-none gap-1 p-0 text-13 font-semibold text-muted hover:bg-transparent hover:text-fg"
            aria-expanded={shown}
            aria-controls={id}
            onClick={() => onOpen(!shown)}
            data-testid="design-banner-more"
          >
            {shown ? t("workflows.banner.less") : t("workflows.banner.more")}
            {shown ? <Icon name="chevronUp" size={14} /> : <Icon name="chevronDown" size={14} />}
          </Button>
        ) : null}
      </div>
      <div className="px-6 pb-2 empty:hidden max-md:px-4" style={{ background: c.bg }}>
        {alert}
      </div>
      <div
        id={id}
        ref={detailRef}
        hidden={!shown}
        className={cn(
          shown ? "grid" : "hidden",
          "gap-1.5 px-6 pb-2.5 text-13 max-md:px-4",
          float && ["absolute inset-x-0 top-full z-30 border-b border-line-subtle pt-2", fixedHeight("sheet")],
        )}
        style={float ? overCanvas : { background: c.bg }}
        data-float={float}
        data-testid="design-banner-detail"
      >
        {reason ? (
          <p className="whitespace-pre-wrap break-words text-fg" data-testid="design-banner-reason">
            {reason}
          </p>
        ) : null}
        {detail}
      </div>
    </div>
  );
}
