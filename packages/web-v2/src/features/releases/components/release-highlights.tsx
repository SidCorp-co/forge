"use client";

import type { ReleaseHighlights } from "@forge/contracts/release-page";
import Link from "next/link";
import { ViewHeading } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { requirementHref } from "@/lib/routes/requirements";
import { ReleaseMedia } from "./release-media";

/** The one to three highlights a release opens on, or what stands in their place and why. */
export function ReleaseHighlightsSection({ highlights, slug, authed }: { highlights: ReleaseHighlights; slug?: string | undefined; authed: boolean }) {
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
      {highlights.state === "failed" ? (
        <div data-testid="page-highlights-failed">
          <p className="text-13 text-muted">{t("releases.page.highlights.failed")}</p>
          <ul className="mt-1 grid gap-0.5 text-12 text-subtle">
            {highlights.refusals.map((r) => (
              <li key={`${r.code}:${r.path}`}>
                <span className="font-mono">{r.code}</span> {r.detail}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {highlights.state === "drafted" ? (
        <ol className="divide-y divide-line-subtle border-y border-line-subtle">
          {highlights.highlights.map((h) => (
            <li key={h.requirement.key} className="grid gap-3 py-5" data-testid="page-highlight">
              <div className="grid gap-1">
                <h3 className="text-16 font-semibold leading-snug">{h.title}</h3>
                <p className="text-13-5">{h.body}</p>
                <p className="text-12-5 text-muted">
                  {slug ? (
                    <Link className="font-mono text-12 text-link hover:underline" href={requirementHref(slug, h.requirement.key)}>
                      {h.requirement.key}
                    </Link>
                  ) : (
                    <span className="font-mono text-12">{h.requirement.key}</span>
                  )}{" "}
                  {t("releases.page.highlights.proves", { codes: h.claims.join(", ") })}
                </p>
              </div>
              {h.media ? (
                <ReleaseMedia media={h.media} label={`${h.title}: ${h.media.name}`} authed={authed} />
              ) : (
                <p className="text-12-5 text-muted" data-testid="page-highlight-gap">
                  {t("releases.page.highlights.noMedia", { why: h.mediaGap ?? "" })}
                </p>
              )}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
