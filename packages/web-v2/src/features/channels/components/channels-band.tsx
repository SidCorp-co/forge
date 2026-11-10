// The Channels overview (REQ-43 r3 BC-14): on the list, how many channels and the people in them, and
// the flow of whether an agent answers each live; on a channel's page, how many members it has and the
// flow of them by whether a person confirmed their roles, an inferred one the person's to
// confirm. Counted over the very rows each page lists (L-57). Neither holds a state that moves over
// time in what core serves, so neither draws a chart (BC-16 is for a screen whose state moves).

import type { ChannelSummaryView, ChannelView } from "@forge/contracts/support-channel";
import { OverviewBand } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";

export function ChannelsBand({ channels }: { channels: readonly ChannelSummaryView[] }) {
  const t = useCopy();
  const live = channels.filter((c) => c.agent).length;
  return (
    <OverviewBand
      label={t("channels.band.label")}
      testId="channels-band"
      figures={[
        { key: "channels", value: channels.length, label: t("channels.title") },
        { key: "members", value: channels.reduce((n, c) => n + c.members, 0), label: t("channels.members") },
      ]}
      flow={[
        { key: "live", label: t("channels.agent.live"), count: live, tone: "ready" },
        { key: "notLive", label: t("channels.agent.notLive"), count: channels.length - live, tone: "neutral" },
      ]}
    />
  );
}

export function ChannelBand({ channel }: { channel: ChannelView }) {
  const t = useCopy();
  const confirmed = channel.memberRows.filter((m) => m.state === "confirmed").length;
  return (
    <OverviewBand
      label={t("channels.band.channel")}
      testId="channel-band"
      figures={[
        { key: "members", value: channel.memberRows.length, label: t("channels.members") },
      ]}
      flow={[
        { key: "confirmed", label: t("channels.state.confirmed"), count: confirmed, tone: "ready" },
        { key: "inferred", label: t("channels.state.inferred"), count: channel.memberRows.length - confirmed, tone: "you" },
      ]}
    />
  );
}
