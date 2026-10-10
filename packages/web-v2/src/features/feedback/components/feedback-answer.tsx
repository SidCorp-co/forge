
// The reporter's answer, first on the item's page: what the header's phase badge does not say — when
// the forecast expects it while the work is planned, and the release that shipped it once it has. A
// phase with nothing to add says nothing here, so the phase is said once (REQ-43 BC-5); who confirmed
// the fix is the rail's Verified row. Every part is read off core (the phase, the forecast, the ship
// notice); this only says it as one sentence.

import type { FeedbackForecast } from "@forge/contracts/forecast";
import { Link } from "@/lib/navigation/router";
import type { ReactNode } from "react";
import { type EtaClock, etaOfFeedback, whenText } from "@/features/forecast";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { releaseHref } from "@/lib/routes/releases";
import type { FeedbackView } from "../types";

/** The release and the moment the item's work shipped, off its ship notice, else off a carrier cut into a release. */
function shippedOf(f: FeedbackView): { release: string | null; at: string | null } {
  const n = f.shipNotice;
  if (n) return { release: n.shipped.release ?? (n.state === "told" ? n.release : null), at: n.shipped.at };
  return { release: f.route?.carriers.find((c) => c.release)?.release ?? null, at: null };
}

/** A sentence with the release name in it drawn as a link to that release. */
function withRelease(text: string, release: string, slug: string): ReactNode {
  const at = text.indexOf(release);
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <Link href={releaseHref(slug, release)} className="font-mono text-link hover:underline">
        {release}
      </Link>
      {text.slice(at + release.length)}
    </>
  );
}

export function FeedbackAnswer({
  f,
  slug,
  forecast,
  clock,
  className,
}: {
  f: FeedbackView;
  slug: string;
  forecast: FeedbackForecast | undefined;
  clock: EtaClock;
  className?: string;
}) {
  const t = useCopy();
  const time = useTimeFormat();
  const said = ((): ReactNode => {
    switch (f.phase) {
      case "new":
      case "reopened":
      case "triaged":
      case "declined":
        return null;
      case "planned": {
        const eta = etaOfFeedback(forecast, clock);
        return eta?.kind === "range" ? t("feedback.answer.plannedEta", { when: whenText(eta.p50At, clock, true) }) : null;
      }
      case "resolved":
      case "verified": {
        // an answer is the route's own, drawn in the rail's Carried by
        if (f.route?.route === "answer") return null;
        const { release, at } = shippedOf(f);
        const head = release ? t("feedback.answer.shippedIn", { release }) : t("feedback.answer.shipped");
        const text = `${head}${at ? t("feedback.answer.on", { date: time.date(at) }) : ""}.`;
        return release ? withRelease(text, release, slug) : text;
      }
    }
  })();
  if (said === null) return null;
  return (
    <p className={`text-14 font-semibold leading-snug text-fg ${className ?? ""}`} data-testid="feedback-answer-line">
      {said}
    </p>
  );
}
