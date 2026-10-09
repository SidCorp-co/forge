"use client";

// A frozen release page a share link opens (BC-11): the user view as it was when it was shared,
// drawn by the same reader the app uses, read-only and with no link into the project. Each clip and
// picture plays from a download link minted for this opening alone.

import { releasePageOfSnapshot } from "@forge/contracts/release-page";
import type { ShareReleaseSnapshot } from "@forge/contracts/shares";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { ReleaseReader } from "./release-reader";

export function SharedReleaseView({ snapshot }: { snapshot: ShareReleaseSnapshot }) {
  const t = useCopy();
  const time = useTimeFormat();
  const page = releasePageOfSnapshot(snapshot.release);
  return (
    <article className="flex flex-col gap-5" data-testid="shared-release">
      <header className="border-b border-line pb-5">
        <p className="fg-caption text-subtle">{t("releases.page.shared.lead")}</p>
        <h1 className="fg-h3 mt-1 font-semibold text-fg">{t("releases.releaseVersion", { version: page.header.version })}</h1>
        <p className="fg-caption mt-1 text-subtle">
          {snapshot.audience === "members" ? "Shared with the project's members" : "Shared by link"} · {t("releases.page.shared.until", { at: time.dateTime(snapshot.expiresAt) })}
        </p>
      </header>
      <ReleaseReader page={page} authed={false} />
    </article>
  );
}
