// Live (ISS-919): each project's latest release on production, then on testing, with how many of
// the person's items it carried; and a search saying where any item stands.

import { SectionTitle, StatusChip, Table, TBody, TD, TH, THead, TR } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { Link } from "@/lib/navigation/router";
import { releaseHref } from "@/lib/routes/releases";
import type { HomeLiveRelease } from "../types";
import { ItemFinder } from "./item-finder";

export function LiveReleases({ live }: { live: HomeLiveRelease[] }) {
  const t = useCopy();
  return (
    <section className="flex flex-col gap-2" aria-labelledby="home-live" data-testid="home-live">
      <SectionTitle id="home-live" className="fg-h3">{t("overview.home.live.title")}</SectionTitle>
      <ItemFinder />
      {live.length === 0 ? (
        <p className="fg-body-sm text-muted">{t("overview.home.live.empty")}</p>
      ) : (
        <Table aria-labelledby="home-live">
          <THead className="sr-only">
            <TR>
              <TH>{t("overview.home.col.release")}</TH>
              <TH className="max-sm:hidden">{t("overview.home.col.project")}</TH>
              <TH>{t("overview.home.col.status")}</TH>
              <TH>{t("overview.home.col.yours")}</TH>
            </TR>
          </THead>
          <TBody>
            {live.map((r) => (
              <LiveRelease key={`${r.projectSlug}:${r.environment}`} release={r} />
            ))}
          </TBody>
        </Table>
      )}
    </section>
  );
}

function LiveRelease({ release: r }: { release: HomeLiveRelease }) {
  const t = useCopy();
  const time = useTimeFormat();
  return (
    <TR data-testid="home-live-row" className="max-sm:flex max-sm:flex-wrap max-sm:items-center" data-environment={r.environment}>
      <TD className="max-sm:basis-full max-sm:pb-0 sm:w-full sm:max-w-0">
        <Link href={releaseHref(r.projectSlug, r.version)} className="line-clamp-1 hover:underline sm:block sm:truncate" title={r.name ?? r.version}>
          {r.name ?? r.version}
        </Link>
        <span className="block text-12 text-muted">{[r.name ? r.version : null, time.relative(r.at)].filter(Boolean).join(" · ")}</span>
      </TD>
      <TD className="text-muted max-sm:hidden sm:w-px sm:whitespace-nowrap">{r.projectName}</TD>
      <TD className="sm:w-px sm:whitespace-nowrap">
        <StatusChip
          tone={r.environment === "production" ? "done" : "ready"}
          label={t(`overview.home.env.${r.environment}`)}
          reason={r.environmentName}
        />
      </TD>
      <TD className="text-muted sm:w-px sm:whitespace-nowrap" title={t("overview.home.yours", { n: r.mine })}>
        {r.mine > 0 ? t("overview.home.yours", { n: r.mine }) : "–"}
      </TD>
    </TR>
  );
}
