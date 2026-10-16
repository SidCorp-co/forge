// The feedback a release answers, read in its Technical view: who asked, and whether this release
// told them.

import { ViewHeading } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { feedbackHref } from "@/lib/routes/feedback";
import { Link } from "@/lib/navigation/router";
import type { ReleaseDetail, ReleaseFeedbackView } from "../types";

const TOLD: Record<ReleaseFeedbackView["told"], (f: ReleaseFeedbackView, t: Copy, stamp: (at: string) => string) => string> = {
  on_ship: (_f, t) => t("releases.toldOnShip"),
  told: (f, t, stamp) => (f.toldAt ? t("releases.toldAt", { at: stamp(f.toldAt) }) : t("releases.told")),
  not_told: (f, t) => (f.agency === "agent" ? t("releases.notToldAgent") : t("releases.notTold")),
  before_notices: (_f, t) => t("releases.toldBeforeNotices"),
};

/** The feedback the release answers: who asked, and whether this release told them. Flush rows, no cards. */
export function FeedbackAnswered({ r, slug }: { r: ReleaseDetail; slug: string }) {
  const t = useCopy();
  const time = useTimeFormat();
  if (r.feedbackAnswered.length === 0) return null;
  return (
    <section aria-label={t("releases.feedbackAnswered")} data-testid="release-feedback">
      <ViewHeading>{t("releases.feedbackAnswered")}</ViewHeading>
      <p className="mb-2 text-13 text-muted" data-testid="release-feedback-counts">
        {(["told", "not_told", "before_notices", "on_ship"] as const)
          .filter((k) => r.feedbackToldCounts[k] > 0)
          .map((k) => t(`releases.toldCount.${k}`, { n: r.feedbackToldCounts[k] }))
          .join(" · ")}
      </p>
      <ul className="border-t border-line-subtle">
        {r.feedbackAnswered.map((f) => (
          <li key={f.key} className="grid grid-cols-1 gap-0.5 border-b border-line-subtle py-2.5 text-13" data-testid="release-feedback-row" data-told={f.told}>
            <span className="flex flex-wrap items-center gap-2">
              <Link className="font-mono text-12 font-semibold text-link hover:underline" href={feedbackHref(slug, f.key)}>
                {f.key}
              </Link>
              <span className="min-w-0 flex-1 truncate">{f.title}</span>
            </span>
            <span className="text-13 text-muted">
              {f.reporter} · {TOLD[f.told](f, t, time.dateTime)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
