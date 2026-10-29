// Product → Channels (REQ-75 r6 BC-30): the project's bound channels, one flat row each.

import { PageTitle, Table, TBody, TD, TH, THead, TR } from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy } from "@/lib/i18n/interface-language";
import { Link } from "@/lib/navigation/router";
import { useChannels } from "../hooks";

export const channelHref = (slug: string, rid: string) => `/projects/${slug}/channels/${encodeURIComponent(rid)}`;

export function ChannelsScreen({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useCopy();
  const q = useChannels(projectId);
  return (
    <div className="grid gap-4 px-5 py-4 max-md:px-3">
      <PageTitle>{t("channels.title")}</PageTitle>
      <QueryBoundary query={q} loadingLabel={t("channels.loading")}>
        {(data) =>
          data.channels.length === 0 ? (
            <p className="fg-body-sm text-muted">{t("channels.none")}</p>
          ) : (
            <Table aria-label={t("channels.title")}>
              <THead>
                <TR>
                  <TH>{t("channels.col.channel")}</TH>
                  <TH>{t("channels.col.members")}</TH>
                  <TH>{t("channels.col.rules")}</TH>
                  <TH>{t("channels.col.commonIssues")}</TH>
                </TR>
              </THead>
              <TBody>
                {data.channels.map((c) => (
                  <TR key={c.rid}>
                    <TD>
                      <Link href={channelHref(slug, c.rid)} className="fg-body-sm text-fg underline-offset-2 hover:underline">
                        {c.name ? `#${c.name}` : c.rid}
                      </Link>
                    </TD>
                    <TD className="fg-body-sm">{c.members}</TD>
                    <TD className="fg-body-sm">{c.rules}</TD>
                    <TD className="fg-body-sm">{c.commonIssues}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )
        }
      </QueryBoundary>
    </div>
  );
}
