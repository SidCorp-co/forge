
// A frozen release page a share link opens (BC-11): the user view as it was when it was shared,
// drawn by the same report the app's page draws (ISS-1001), read-only and with no link into the project.

import { releasePageOfSnapshot } from "@forge/contracts/release-page";
import type { ShareReleaseSnapshot } from "@forge/contracts/shares";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { releaseTitle } from "./release-bits";
import { ReleaseReport } from "./release-report";

export function SharedReleaseView({ snapshot }: { snapshot: ShareReleaseSnapshot }) {
  const t = useCopy();
  const time = useTimeFormat();
  const page = releasePageOfSnapshot(snapshot.release);
  return (
    <article className="flex flex-col gap-5" data-testid="shared-release">
      <header className="border-b border-line pb-5">
        <p className="fg-caption text-subtle">{t("releases.page.shared.lead")}</p>
        <h1 className="fg-h3 mt-1 font-semibold text-fg">{releaseTitle(page.header, t)}</h1>
        <p className="fg-caption mt-1 text-subtle">
          {snapshot.audience === "members" ? t("releases.page.shared.members") : t("releases.page.shared.link")} · {t("releases.page.shared.until", { at: time.dateTime(snapshot.expiresAt) })}
        </p>
      </header>
      <ReleaseReport page={page} />
    </article>
  );
}
