// What a GitHub App's directory row says beyond its usage line: an installation recorded for the
// caller's org that no project uses yet, an App GitHub keeps private, and an App that still waits on
// an operator to complete it. Each line is a fact core read; nothing here is inferred.

import { useCopy } from "@/lib/i18n/interface-language";
import { useGitHubAppRow } from "./app";

export function GitHubAppRowDetail({ connectionId }: { connectionId: string }) {
  const row = useGitHubAppRow(connectionId);
  const t = useCopy();
  const data = row.data;
  if (!data) return null;
  const unused = data.installations.filter((i) => i.state === "active" && !i.used);

  return (
    <span className="flex w-full flex-col gap-1" data-testid="github-app-row-detail">
      {data.completePath && <span className="fg-body-sm text-warn-11">{t("integrations.github.row.awaitsCompletion")}</span>}
      {unused.map((i) => (
        <span key={i.installationId} className="fg-body-sm text-muted">
          {t("integrations.github.row.unused", { account: i.account })}{" "}
          <a
            href={i.settingsUrl}
            target="_blank"
            rel="noreferrer"
            className="text-accent-text hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {t("integrations.github.row.openInstallation")}
          </a>
        </span>
      ))}
      {data.visibility === "private" && (
        <span className="fg-body-sm text-warn-11">
          {t("integrations.github.row.private", { owner: data.owner ?? t("integrations.github.row.itsOwner") })}{" "}
          {data.makePublicUrl && (
            <a
              href={data.makePublicUrl}
              target="_blank"
              rel="noreferrer"
              className="text-accent-text hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {t("integrations.github.row.makePublic")}
            </a>
          )}
        </span>
      )}
    </span>
  );
}
