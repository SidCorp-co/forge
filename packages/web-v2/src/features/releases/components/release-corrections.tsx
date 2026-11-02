// The shipped-in corrections a release keeps, read in its Technical view (ISS-846): one row per
// correction, naming the issue and where it moved; why, who and when open on demand.

import { ViewHeading } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { Link } from "@/lib/navigation/router";
import { issueHref } from "@/lib/routes/issues";
import type { ReleaseDetail } from "../types";

export function ReleaseCorrections({ r, slug }: { r: Pick<ReleaseDetail, "corrections">; slug: string }) {
  const t = useCopy();
  const time = useTimeFormat();
  if (r.corrections.length === 0) return null;
  return (
    <section aria-label={t("releases.corrections")} data-testid="release-corrections">
      <ViewHeading>{t("releases.corrections")}</ViewHeading>
      <ul className="border-t border-line-subtle">
        {r.corrections.map((c) => (
          <li key={`${c.key}-${c.at}-${c.direction}`} className="grid grid-cols-1 gap-0.5 border-b border-line-subtle py-2.5 text-13" data-testid="release-correction-row" data-direction={c.direction}>
            <span className="flex flex-wrap items-center gap-2">
              <Link className="font-mono text-12 font-semibold text-link hover:underline" href={issueHref(slug, c.key)}>
                {c.key}
              </Link>
              <span className="min-w-0 flex-1 truncate">{c.title}</span>
              <span className="text-muted" title={c.reason}>
                {c.direction === "out" ? t("releases.correctionOut", { version: c.to }) : t("releases.correctionIn", { version: c.from })}
              </span>
            </span>
            <details className="text-13 text-muted">
              <summary className="cursor-pointer">{t("releases.correctionWhy")}</summary>
              <p className="break-words">{c.reason}</p>
              <p className="break-words font-mono text-12">{c.evidence}</p>
              <p>
                {c.by.name} · {time.dateTime(c.at)}
              </p>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
