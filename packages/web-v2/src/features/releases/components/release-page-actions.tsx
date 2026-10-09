"use client";

// What a person does with a release page they can read (BC-11): share it by Forge link, or take it
// out as Markdown or as an email file to send from their own mail. Forge sends no mail. Both exports
// are built here in the browser from the page's user sections (`release-page-export.ts`).

import { releasePageEml, releasePageEmail, releasePageMarkdown } from "@forge/contracts/release-page-export";
import { useState } from "react";
import { Button } from "@/design";
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
  return (
    <span className="flex flex-wrap items-center gap-2" data-testid="release-page-actions">
      {page.can.share ? (
        <Button size="sm" onClick={() => setSharing(true)} data-testid="release-page-share">
          {t("releases.page.export.share")}
        </Button>
      ) : null}
      {page.can.export ? (
        <>
          <Button
            size="sm"
            data-testid="release-page-copy"
            onClick={() => void navigator.clipboard?.writeText(markdown()).then(() => setCopied(true))}
          >
            {copied ? t("releases.page.export.copied") : t("releases.page.export.copy")}
          </Button>
          <Button
            size="sm"
            data-testid="release-page-markdown"
            onClick={() => saveFile(`release-${version}.md`, new Blob([markdown()], { type: "text/markdown;charset=utf-8" }))}
          >
            {t("releases.page.export.markdown")}
          </Button>
          <Button
            size="sm"
            data-testid="release-page-email"
            onClick={() =>
              saveFile(
                `release-${version}.eml`,
                new Blob([releasePageEml(releasePageEmail(page, opts()), new Date())], { type: "message/rfc822" }),
              )
            }
          >
            {t("releases.page.export.email")}
          </Button>
        </>
      ) : null}
      {sharing ? <ShareDialog projectId={projectId} subject={{ kind: "release", id: version }} onClose={() => setSharing(false)} /> : null}
    </span>
  );
}
