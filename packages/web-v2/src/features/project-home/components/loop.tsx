// The loop the home opens on (REQ-43 BC-14): Product → Delivery → Release → Audit, and Audit's
// findings back to Product. Each stage is its name, its one live figure, a bar of its parts with
// their counts, and one line; pressing it opens its drawer. Flat (REQ-12 BC-1): the loop is one
// tone, each stage a lighter tone on it, no frame and no shadow.

import type { ProjectHome } from "@forge/contracts/project-home";
import { CoverageBar } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { type Part, SERIES, type StageId, shareOf, stageParts } from "../model";
import { Ring } from "./ring";

export interface StageView {
  id: StageId;
  big: string;
  unit: string;
  sub: string;
  parts: Part[];
  /** The share a ring draws beside the figure; null where the figure is a count. */
  ring: number | null;
}

export function stageViews(home: ProjectHome, t: Copy): StageView[] {
  const parts = stageParts(home);
  const { proven, total } = home.product.criteria;
  const share = shareOf(proven, total);
  return [
    {
      id: "product",
      big: `${Math.round(share * 100)}%`,
      unit: t("home.unit.proven"),
      sub: t("home.sub.product", { n: home.product.requirements, m: home.product.feedbackOpen }),
      parts: parts.product,
      ring: share,
    },
    { id: "delivery", big: String(home.delivery.open), unit: t("home.unit.inFlight"), sub: t("home.sub.delivery", { n: home.delivery.running }), parts: parts.delivery, ring: null },
    { id: "release", big: String(home.release.shipped), unit: t("home.unit.releases"), sub: t("home.sub.release", { n: home.release.issues }), parts: parts.release, ring: null },
    { id: "audit", big: String(home.audit.open), unit: t("home.unit.findings"), sub: t("home.sub.audit", { n: home.audit.cleared }), parts: parts.audit, ring: null },
  ];
}

export function StageBar({ parts }: { parts: readonly Part[] }) {
  const t = useCopy();
  return <CoverageBar segments={parts.map((p, i) => ({ key: p.key, label: t(p.label), count: p.count, fill: SERIES[i % SERIES.length] }))} />;
}

function Arrow() {
  return (
    <span aria-hidden className="flex flex-none items-center justify-center py-0.5 text-subtle md:w-8 md:py-0">
      <svg viewBox="0 0 24 24" width="18" height="18" className="rotate-90 md:rotate-0">
        <path d="M4 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

/** Audit's findings return to Product: a dashed line under the row, from the last stage to the first. */
function ReturnLine({ label }: { label: string }) {
  return (
    <div className="hidden h-6 px-24 text-subtle md:block" title={label} data-testid="home-loop-return">
      <svg aria-hidden viewBox="0 0 100 24" preserveAspectRatio="none" className="block h-6 w-full">
        <path d="M100 0 V14 Q100 20 94 20 H6 Q0 20 0 14 V4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
        <path d="M-3 7 L0 2 L3 7" fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

export function Loop({ stages, onOpen }: { stages: readonly StageView[]; onOpen: (id: StageId) => void }) {
  const t = useCopy();
  return (
    <section aria-label={t("home.loop")} className="bg-sunken p-2 md:p-3" data-testid="home-loop">
      <ol className="m-0 flex list-none flex-col p-0 md:flex-row md:items-stretch">
        {stages.map((s, i) => (
          <li key={s.id} className="flex min-w-0 flex-1 flex-col md:flex-row">
            <button
              type="button"
              aria-haspopup="dialog"
              onClick={() => onOpen(s.id)}
              data-testid={`home-stage-${s.id}`}
              className="flex min-w-0 flex-1 flex-col gap-2 rounded-md bg-surface px-4 py-3 text-left transition-colors hover:bg-hover focus-visible:shadow-focus focus-visible:outline-none"
            >
              <span className="text-12 font-semibold uppercase tracking-wide text-subtle">{t(`home.stage.${s.id}`)}</span>
              <span className="flex items-center gap-3">
                {s.ring !== null ? <Ring share={s.ring} /> : null}
                <span className="flex min-w-0 flex-col">
                  <span className="text-24 font-semibold tabular-nums text-fg" data-testid={`home-stage-${s.id}-figure`}>
                    {s.big}
                  </span>
                  <span className="text-13 text-muted">{s.unit}</span>
                </span>
              </span>
              <StageBar parts={s.parts} />
              <span className="text-12 text-subtle">{s.sub}</span>
            </button>
            {i < stages.length - 1 ? <Arrow /> : null}
          </li>
        ))}
      </ol>
      <ReturnLine label={t("home.loop.return")} />
    </section>
  );
}
