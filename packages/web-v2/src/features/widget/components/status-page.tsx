import { WIDGET_STATUS_TOKEN_PATTERN, type WidgetStatus } from "@forge/contracts/widget";
import { Badge, Kicker, Spinner } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { cn } from "@/lib/utils/cn";
import { useWidgetStatus } from "../hooks/queries";
import { type Shown, shownOf } from "../refusal";
import { RefusalNote } from "./refusal-note";

const STEPS = ["received", "triaged", "in_progress", "shipped"] as const;
const phaseKey = (phase: WidgetStatus["phase"]): ProductCopyKey => `widget.status.phase.${phase}`;
const UNKNOWN: Shown = { code: "WIDGET_STATUS_UNKNOWN", rawCode: "WIDGET_STATUS_UNKNOWN", detail: null };

function Steps({ phase }: { phase: WidgetStatus["phase"] }) {
  const t = useCopy();
  const at = STEPS.indexOf(phase as (typeof STEPS)[number]);
  return (
    <ol className="flex flex-col gap-0 sm:flex-row sm:gap-2" aria-label={t("widget.status.steps")} data-testid="widget-status-steps">
      {STEPS.map((step, i) => {
        const done = at >= i;
        const current = at === i;
        return (
          <li
            key={step}
            className="flex flex-1 items-center gap-2 py-1 sm:flex-col sm:items-start"
            aria-current={current ? "step" : undefined}
            data-done={done || undefined}
          >
            <span className={cn("h-1 w-6 flex-none rounded-full sm:w-full", done ? "bg-ok-9" : "bg-line")} aria-hidden />
            <span className={cn("text-13", current ? "font-semibold text-fg" : done ? "text-muted" : "text-subtle")}>
              {t(phaseKey(step))}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function StatusView({ status }: { status: WidgetStatus }) {
  const t = useCopy();
  const time = useTimeFormat();
  return (
    <article className="flex flex-col gap-6" data-testid="widget-status" data-phase={status.phase}>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <Kicker>{t("widget.status.kicker")}</Kicker>
          {status.phase === "closed" && <Badge>{t("widget.status.phase.closed")}</Badge>}
        </div>
        <h1 className="fg-h2 text-fg">{status.title}</h1>
      </div>
      <p className="fg-body text-fg" data-testid="widget-status-says">
        {status.says}
      </p>
      {status.phase !== "closed" && <Steps phase={status.phase} />}
      <p className="fg-caption flex flex-wrap gap-x-3 gap-y-1 text-subtle">
        <span className="font-mono">{t("widget.status.ref", { key: status.feedbackKey })}</span>
        <span>{t("widget.status.filed", { at: time.date(status.filedAt) })}</span>
        <span>{t("widget.status.updated", { at: time.relative(status.updatedAt) })}</span>
      </p>
    </article>
  );
}

/** A visitor's private status link: where what they sent stands, in one plain sentence, and nothing more. */
export function WidgetStatusPage({ token }: { token: string }) {
  const t = useCopy();
  const wellFormed = WIDGET_STATUS_TOKEN_PATTERN.test(token);
  const status = useWidgetStatus(token, wellFormed);
  return (
    <div className="min-h-dvh bg-app">
      <main className="mx-auto flex max-w-xl flex-col gap-6 px-4 py-12 sm:py-20">
        {!wellFormed || status.isError ? (
          <RefusalNote refusal={wellFormed ? shownOf(status.error) : UNKNOWN} />
        ) : status.data ? (
          <StatusView status={status.data} />
        ) : (
          <p className="fg-body-sm flex items-center gap-2 text-muted" role="status">
            <Spinner size={14} />
            {t("widget.status.loading")}
          </p>
        )}
        <p className="fg-caption text-subtle">{t("widget.frame.powered")}</p>
      </main>
    </div>
  );
}
