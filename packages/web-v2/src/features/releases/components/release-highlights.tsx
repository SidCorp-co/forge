
import type { ReleaseHighlights } from "@forge/contracts/release-page";
import { useState } from "react";
import { Link } from "@/lib/navigation/router";
import { ViewHeading } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { requirementHref } from "@/lib/routes/requirements";
import { DisclosureToggle } from "./release-bits";
import { ReleaseMedia } from "./release-media";

/** Why no highlight was drafted: one line, and the drafter's refusals (agent text) behind a fold. */
function HighlightsFailed({ refusals }: { refusals: Extract<ReleaseHighlights, { state: "failed" }>["refusals"] }) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="page-highlights-failed">
      <DisclosureToggle open={open} onToggle={() => setOpen((o) => !o)} className="text-13" testId="page-highlights-failed-toggle">
        {t("releases.page.highlights.failed")}
      </DisclosureToggle>
      {open ? (
        <ul className="mt-1 grid gap-0.5 text-12 text-subtle">
          {refusals.map((r) => (
            <li key={`${r.code}:${r.path}`}>
              <span className="font-mono">{r.code}</span> {r.detail}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The one to three highlights a release opens on, or what stands in their place and why; the criterion
 * codes a highlight claims are its title, not its text. `gaps` says a highlight with no clip says so:
 * the release page does, for the people deciding on it; What's new shows only what there is to see.
 */
export function ReleaseHighlightList({ highlights, slug, authed, gaps = true }: { highlights: ReleaseHighlights; slug?: string | undefined; authed: boolean; gaps?: boolean }) {
  const t = useCopy();
  if (highlights.state === "none") return null;
  return (
    <section aria-label={t("releases.page.highlights.title")} data-testid="page-highlights" data-state={highlights.state}>
      <ViewHeading>{t("releases.page.highlights.title")}</ViewHeading>
      {highlights.state === "pending" ? (
        <p className="text-13 text-muted" data-testid="page-highlights-pending">
          {t("releases.page.highlights.pending")}
        </p>
      ) : null}
      {highlights.state === "failed" ? <HighlightsFailed refusals={highlights.refusals} /> : null}
      {highlights.state === "drafted" ? (
        <ol className="divide-y divide-line-subtle border-y border-line-subtle">
          {highlights.highlights.map((h) => (
            <li key={h.requirement.key} className="grid gap-3 py-5" data-testid="page-highlight">
              <div className="grid gap-1">
                <h3 className="text-16 font-semibold leading-snug">{h.title}</h3>
                <p className="text-14">{h.body}</p>
                <p className="text-12 text-subtle" title={t("releases.page.highlights.proves", { codes: h.claims.join(", ") })}>
                  {slug ? (
                    <Link className="font-mono text-link hover:underline" href={requirementHref(slug, h.requirement.key)}>
                      {h.requirement.key}
                    </Link>
                  ) : (
                    <span className="font-mono">{h.requirement.key}</span>
                  )}
                </p>
              </div>
              {h.media ? (
                <ReleaseMedia media={h.media} label={h.title} authed={authed} />
              ) : gaps ? (
                <p className="text-13 text-muted" data-testid="page-highlight-gap">
                  {t("releases.page.highlights.mediaGap")}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
