// Who answers a bound channel (ISS-1180, REQ-75 r7 BC-42): the agent session its binding places, by
// its role, live or not, and its recent turns one click away on the session's own page. Its box and
// since when are the live mark's tooltip; the session's address is a raw id and never shown. The
// Channels list names the same agent and mark on each row (ISS-1184).

import { FORGE_SESSION_ADDRESS_PREFIX, type AgentRoleView } from "@forge/contracts/support-channel";
import { ToneBadge } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { Link } from "@/lib/navigation/router";
import { sessionHref } from "@/lib/routes/automation";

/** The Forge session an address names; an outside agent's own address is no page here. */
const forgeSessionOf = (address: string) => (address.startsWith(FORGE_SESSION_ADDRESS_PREFIX) ? address.slice(FORGE_SESSION_ADDRESS_PREFIX.length) : null);

const roleName = (role: string) => role.charAt(0).toUpperCase() + role.slice(1);

/** "Operations agent", or one outside Forge: who answers the room, as the page and the list row name it. */
export function useAgentName() {
  const t = useCopy();
  return (agent: AgentRoleView) => t(agent.answeredBy === "outside" ? "channels.agent.outside" : "channels.agent.role", { role: roleName(agent.role) });
}

/** Live or Not live: one word and a mark, the agent's box and since when its tooltip. */
export function AgentLive({ agent }: { agent: AgentRoleView | null }) {
  const t = useCopy();
  const time = useTimeFormat();
  const where = agent ? [agent.box ? t("channels.agent.onBox", { box: agent.box }) : null, t("channels.agent.since", { at: time.dateTime(agent.since) })].filter(Boolean).join(" · ") : undefined;
  return (
    <span data-testid="channel-agent-live">
      <ToneBadge tone={agent ? "ready" : "neutral"} label={t(agent ? "channels.agent.live" : "channels.agent.notLive")} title={where ?? t("channels.agent.none")} />
    </span>
  );
}

export function ChannelAgent({ agent, slug }: { agent: AgentRoleView | null; slug: string }) {
  const t = useCopy();
  const name = useAgentName();
  const session = agent ? forgeSessionOf(agent.address) : null;
  return (
    // the page's first line, named for screen readers only: the agent's role and its state say it
    <section className="flex flex-wrap items-center gap-x-3 gap-y-1" aria-label={t("channels.agent.title")} data-testid="channel-agent">
      {agent ? <span className="fg-body-sm font-medium text-fg">{name(agent)}</span> : null}
      <AgentLive agent={agent} />
      {session ? (
        <Link href={sessionHref(slug, session)} className="fg-body-sm font-medium text-link hover:underline">
          {t("channels.agent.turns")}
        </Link>
      ) : null}
    </section>
  );
}
