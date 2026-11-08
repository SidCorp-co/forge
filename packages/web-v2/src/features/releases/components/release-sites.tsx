// ISS-1077: a release over a production of several sites names each site and where it stands, so a
// site the release did not reach reads as not shipped, by its name. A name and a status per site;
// what it serves and where opens on hover or focus (the ui-copy rule). One site says nothing here.

import { RELEASE_SITE_STATE_TONES } from "@forge/contracts/releases";
import { StatusChip } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ReleaseDetail } from "../types";

export function ReleaseSites({ r }: { r: Pick<ReleaseDetail, "sites"> }) {
  const t = useCopy();
  const sites = r.sites ?? [];
  if (sites.length < 2) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-2 text-13" aria-label={t("releases.sites.label")} data-testid="release-sites">
      {sites.map((s) => {
        const detail = [s.serves ? t("releases.sites.serves", { what: s.serves }) : null, s.url].filter(Boolean).join(" · ");
        return (
          <li key={s.name} className="flex items-center gap-2" data-testid="release-site" data-site={s.name} data-state={s.state}>
            <span className="font-medium text-fg">{s.name}</span>
            <StatusChip tone={RELEASE_SITE_STATE_TONES[s.state]} label={t(`releases.sites.state.${s.state}`)} reason={detail || null} />
          </li>
        );
      })}
    </ul>
  );
}
