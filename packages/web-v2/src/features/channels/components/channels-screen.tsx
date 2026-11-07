// Product → Channels (REQ-75 r6 BC-30): the project's bound channels on the shared grouped list (ISS-1072),
// each row led by the channel's name, its facts only the counts that hold something. A row opens the
// channel's own page, where its members, rules, common issues and routes are read in full.

import type { ChannelSummaryView } from "@forge/contracts/support-channel";
import { GroupedList, type ListRowView, PageTitle, useGroupFold } from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";
import { useCopy } from "@/lib/i18n/interface-language";
import { useRouter } from "@/lib/navigation/router";
import { useChannels } from "../hooks";

export const channelHref = (slug: string, rid: string) => `/projects/${slug}/channels/${encodeURIComponent(rid)}`;

const COUNTS = ["members", "rules", "commonIssues"] as const;

function channelRow(slug: string, t: Copy) {
  return (c: ChannelSummaryView): ListRowView => ({
    key: c.rid,
    href: channelHref(slug, c.rid),
    title: c.name ? `#${c.name}` : t("channels.unnamed"),
    facts: COUNTS.filter((k) => c[k] > 0).map((k) => t(`channels.count.${k}.${c[k] === 1 ? "one" : "many"}` as ProductCopyKey, { n: c[k] })),
    state: null,
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
              row={channelRow(slug, t)}
              selected={null}
              onPeek={(rid) => router.push(channelHref(slug, rid))}
              columns={{ title: t("channels.col.channel"), state: "", waitingOn: "", meta: "" }}
              keyColumn={false}
            />
          )
        }
      </QueryBoundary>
    </div>
  );
}
