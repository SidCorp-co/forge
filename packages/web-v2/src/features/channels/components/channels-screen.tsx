// Product → Channels (REQ-75 r6 BC-30): the project's bound channels on the shared grouped list (ISS-1072),
// each row led by the channel's name, then who answers it and whether that agent is live (ISS-1184),
// its facts only the counts that hold something. A row opens the channel's own page, where its
// members, rules, common issues and routes are read in full.

import type { ChannelSummaryView } from "@forge/contracts/support-channel";
import { GroupedList, type ListRowView, PageTitle, useGroupFold } from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";
import { useCopy } from "@/lib/i18n/interface-language";
import { useRouter } from "@/lib/navigation/router";
import { useChannels } from "../hooks";
import { AgentLive, useAgentName } from "./channel-agent";

export const channelsListHref = (slug: string) => `/projects/${slug}/channels`;
export const channelHref = (slug: string, rid: string) => `${channelsListHref(slug)}/${encodeURIComponent(rid)}`;

const COUNTS = ["members", "rules", "commonIssues"] as const;

function channelRow(slug: string, t: Copy, agentName: (a: NonNullable<ChannelSummaryView["agent"]>) => string) {
  return (c: ChannelSummaryView): ListRowView => ({
    key: c.rid,
    href: channelHref(slug, c.rid),
    title: c.name ? `#${c.name}` : t("channels.unnamed"),
    facts: [
      ...(c.agent ? [<span key="agent" data-testid="channel-row-agent">{agentName(c.agent)}</span>] : []),
      ...COUNTS.filter((k) => c[k] > 0).map((k) => t(`channels.count.${k}.${c[k] === 1 ? "one" : "many"}` as ProductCopyKey, { n: c[k] })),
    ],
    state: <AgentLive agent={c.agent} />,
    waitingOn: null,
    owner: null,
    age: null,
  });
}

export function ChannelsScreen({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useCopy();
  const q = useChannels(projectId);
  const fold = useGroupFold("web-v2:channels-fold");
  const router = useRouter();
  const agentName = useAgentName();
  return (
    <div className="grid gap-4 px-5 py-4 max-md:px-3">
      <PageTitle>{t("channels.title")}</PageTitle>
      <QueryBoundary query={q} loadingLabel={t("channels.loading")}>
        {(data) =>
          data.channels.length === 0 ? (
            <p className="fg-body-sm text-muted">{t("channels.none")}</p>
          ) : (
            <GroupedList
              ariaLabel={t("channels.title")}
              groups={[{ id: "bound", label: t("channels.group.bound"), rows: data.channels }]}
              fold={fold}
              row={channelRow(slug, t, agentName)}
              selected={null}
              onPeek={(rid) => router.push(channelHref(slug, rid))}
              columns={{ title: t("channels.col.channel"), state: t("channels.col.agent"), waitingOn: "", meta: "" }}
              keyColumn={false}
            />
          )
        }
      </QueryBoundary>
    </div>
  );
}
