
// What a person does with a release page they can read (BC-11): share it by Forge link, or take it
// out, from one Export menu, as Markdown or as an email file to send from their own mail. Forge sends no mail. Both exports
// are built here in the browser from the page's user sections (`release-page-export.ts`).

import { releasePageEml, releasePageEmail, releasePageMarkdown } from "@forge/contracts/release-page-export";
import { useState } from "react";
import { Button, Menu, type MenuItem } from "@/design";
import { ShareDialog } from "@/features/shares";
import { useCopy } from "@/lib/i18n/interface-language";
import { saveFile } from "@/lib/utils/save-file";
import type { ReleasePage } from "../types";

export function ReleasePageActions({ projectId, page }: { projectId: string; page: ReleasePage }) {
  const t = useCopy();
  const [sharing, setSharing] = useState(false);
  const [copied, setCopied] = useState(false);
  const version = page.header.version;
  const opts = () => ({ origin: window.location.origin });
  const markdown = () => releasePageMarkdown(page, opts());
  if (!page.can.share && !page.can.export) return null;
  const exports: MenuItem[] = [
    {
      label: copied ? t("releases.page.export.copied") : t("releases.page.export.copy"),
      onSelect: () => void navigator.clipboard?.writeText(markdown()).then(() => setCopied(true)),
    },
    {
      label: t("releases.page.export.markdown"),
      onSelect: () => saveFile(`release-${version}.md`, new Blob([markdown()], { type: "text/markdown;charset=utf-8" })),
    },
    {
      label: t("releases.page.export.email"),
      onSelect: () =>
        saveFile(`release-${version}.eml`, new Blob([releasePageEml(releasePageEmail(page, opts()), new Date())], { type: "message/rfc822" })),
    },
  ];
  return (
    <span className="flex flex-wrap items-center gap-2" data-testid="release-page-actions">
      {page.can.share ? (
        <Button size="sm" onClick={() => setSharing(true)} data-testid="release-page-share">
          {t("releases.page.export.share")}
        </Button>
      ) : null}
      {page.can.export ? (
        <Menu
          align="right"
          items={exports}
          trigger={
            <Button size="sm" icon="chevronDown" data-testid="release-page-export">
              {t("releases.page.export.menu")}
            </Button>
          }
        />
      ) : null}
      {sharing ? <ShareDialog projectId={projectId} subject={{ kind: "release", id: version }} onClose={() => setSharing(false)} /> : null}
    </span>
  );
}
