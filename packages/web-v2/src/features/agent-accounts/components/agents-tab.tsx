"use client";

// Settings → Agents. An org admin's view of the agent accounts in their
// organization: what each one is called, what it is addressed as, whether it
// can act at all, and the two verbs that change that.
//
// The population this exists for is the handles a conversation mints. Those get
// a name in a room and NO token by design, so they were permanently unable to
// answer and there was no surface anywhere in the product that could give them
// one — the three routes behind it had no caller (ISS-1003).

import { ORG_ROLE_PERMISSIONS } from "@forge/contracts/permissions";
import { useState } from "react";
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  MonoTag,
  Section,
  SectionTitle,
  Skeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  ToneBadge,
  TR,
} from "@/design";
import { useActiveOrg } from "@/features/orgs";
import { useOrgScopedProjects } from "@/features/projects";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { useToast } from "@/providers/toast-provider";
import {
  useAgentAccounts,
  useMintAgentCredential,
  useRevokeAgentCredentials,
  useSetAgentDisplayName,
} from "../hooks";
import { agentAddress, agentLabel, agentProjectNames, reachOf } from "../label";
import type { AgentAccountRow } from "../types";
import { AgentSelfEditor } from "./agent-self-editor";
import { CreateAgentForm } from "./create-agent-form";

type Copy = ReturnType<typeof useCopy>;

export function AgentsTab() {
  const [selfOpen, setSelfOpen] = useState<string | null>(null);
  const { activeOrg } = useActiveOrg();
  const orgId = activeOrg?.id ?? null;
  const agentsQ = useAgentAccounts(orgId);
  const mint = useMintAgentCredential(orgId);
  const revoke = useRevokeAgentCredentials(orgId);
  const { toast } = useToast();
  const t = useCopy();
  const [revealed, setRevealed] = useState<{ userId: string; plaintext: string } | null>(null);

  if (activeOrg && !ORG_ROLE_PERMISSIONS[activeOrg.role].includes("org.admin")) return <EmptyState message={t("settings.agents.adminOnly")} />;
  if (!orgId || agentsQ.isLoading) return <Skeleton className="h-40 w-full" />;
  if (agentsQ.isError) return <ErrorState title={t("settings.agents.loadFailed")} message={formatApiError(agentsQ.error)} />;

  const agents = agentsQ.data ?? [];
  const busy = mint.isPending || revoke.isPending;

  async function onMint(agent: AgentAccountRow) {
    try {
      const { plaintext } = await mint.mutateAsync(agent.userId);
      setRevealed({ userId: agent.userId, plaintext });
    } catch (err) {
      toast({ title: t("settings.agents.mintFailed"), description: formatApiError(err), tone: "error" });
    }
  }

  async function onRevoke(agent: AgentAccountRow) {
    try {
      const { revoked } = await revoke.mutateAsync(agent.userId);
      if (revealed?.userId === agent.userId) setRevealed(null);
      toast({
        title: revoked === 0 ? t("settings.agents.heldNone") : t("settings.agents.revoked", { n: revoked }),
        description: t("settings.agents.keepsPlace", { name: agentLabel(agent) }),
        tone: "success",
      });
    } catch (err) {
      toast({ title: t("settings.agents.revokeFailed"), description: formatApiError(err), tone: "error" });
    }
  }

  const openAgent = selfOpen ? agents.find((a) => a.userId === selfOpen) : undefined;
  return (
    <div className="space-y-6">
      <SectionTitle className="fg-h3">{t("settings.agents.title", { org: activeOrg?.name ?? t("settings.agents.thisOrg") })}</SectionTitle>
      {revealed ? <RevealedCredential plaintext={revealed.plaintext} onDone={() => setRevealed(null)} /> : null}
      <CreateAgentForm orgId={orgId} />
      {agents.length === 0 ? (
        <EmptyState message={t("settings.agents.none")} />
      ) : (
        <Section>
          <Table>
            <THead>
              <TR>
                <TH>{t("settings.agents.name")}</TH>
                <TH>{t("settings.agents.address")}</TH>
                <TH>{t("settings.orgs.projects")}</TH>
                <TH>{t("settings.agents.canAct")}</TH>
                <TH aria-label={t("settings.agents.actions")} />
              </TR>
            </THead>
            <TBody>
              {agents.map((agent) => (
                <AgentEntry
                  key={agent.userId}
                  orgId={orgId}
                  agent={agent}
                  busy={busy}
                  selfOpen={selfOpen === agent.userId}
                  onToggleSelf={() => setSelfOpen(selfOpen === agent.userId ? null : agent.userId)}
                  onMint={() => void onMint(agent)}
                  onRevoke={() => void onRevoke(agent)}
                />
              ))}
            </TBody>
          </Table>
          {openAgent ? (
            <Section title={t("settings.agents.selfOf", { name: agentLabel(openAgent) })} className="mt-6">
              <AgentSelfEditor orgId={orgId} agentUserId={openAgent.userId} handle={agentAddress(openAgent)} />
            </Section>
          ) : null}
        </Section>
      )}
    </div>
  );
}

/** A freshly minted credential, shown once: core keeps only its hash. */
function RevealedCredential({ plaintext, onDone }: { plaintext: string; onDone: () => void }) {
  const { toast } = useToast();
  const t = useCopy();
  async function copy() {
    try {
      await navigator.clipboard.writeText(plaintext);
      toast({ title: t("settings.agents.copied"), tone: "success" });
    } catch {
      toast({ title: t("settings.agents.copyFailed"), description: t("settings.agents.copyByHand"), tone: "error" });
    }
  }
  return (
    <Section title={t("settings.agents.copyNow")}>
      <p className="fg-body-sm mb-3">{t("settings.agents.hashOnly")}</p>
      <MonoTag>{plaintext}</MonoTag>
      <div className="mt-3 flex gap-2">
        <Button variant="secondary" onClick={() => void copy()}>
          {t("settings.agents.copy")}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {t("settings.agents.haveIt")}
        </Button>
      </div>
    </Section>
  );
}

/** One agent: its name (renamed in place), address, projects, whether it can act, and its verbs. */
function AgentEntry({
  orgId,
  agent,
  busy,
  selfOpen,
  onToggleSelf,
  onMint,
  onRevoke,
}: {
  orgId: string;
  agent: AgentAccountRow;
  busy: boolean;
  selfOpen: boolean;
  onToggleSelf: () => void;
  onMint: () => void;
  onRevoke: () => void;
}) {
  const t = useCopy();
  const { projects } = useOrgScopedProjects();
  const reach = reachOf(agent);
  const nameOf = (projectId: string) => projects.find((p) => p.id === projectId)?.name;
  return (
    <TR>
      <TD>
        <AgentName orgId={orgId} agent={agent} t={t} />
      </TD>
      <TD>
        <MonoTag>{agentAddress(agent)}</MonoTag>
      </TD>
      <TD>{agentProjectNames(agent, nameOf, t("settings.agents.noProjects"))}</TD>
      <TD>
        {reach.canAct ? (
          <ToneBadge tone="ready" label={t("settings.agents.yes")} title={t("settings.agents.yes")} />
        ) : (
          <div>
            <ToneBadge tone="you" label={t("settings.agents.noWhy", { why: t(reach.why) })} title={t(reach.remedy)} />
            <p className="fg-body-sm mt-1">{t(reach.remedy)}</p>
          </div>
        )}
      </TD>
      <TD>
        <div className="flex gap-2">
          <Button variant="secondary" disabled={busy} onClick={onMint}>
            {agent.activeTokens > 0 ? t("settings.agents.mintAnother") : t("settings.agents.give")}
          </Button>
          <Button variant="ghost" disabled={busy || agent.activeTokens === 0} onClick={onRevoke}>
            {t("settings.agents.revoke")}
          </Button>
          <Button variant="ghost" aria-expanded={selfOpen} onClick={onToggleSelf}>
            {selfOpen ? t("settings.agents.closeSelf") : t("settings.agents.self")}
          </Button>
        </div>
      </TD>
    </TR>
  );
}

function AgentName({ orgId, agent, t }: { orgId: string; agent: AgentAccountRow; t: Copy }) {
  const rename = useSetAgentDisplayName(orgId);
  const { toast } = useToast();
  const [value, setValue] = useState<string | null>(null);
  async function save(next: string) {
    try {
      await rename.mutateAsync({ agentUserId: agent.userId, displayName: next.trim() === "" ? null : next.trim() });
      setValue(null);
    } catch (err) {
      toast({ title: t("settings.agents.nameFailed"), description: formatApiError(err), tone: "error" });
    }
  }
  if (value === null) {
    return (
      <button type="button" className="text-left" onClick={() => setValue(agent.displayName ?? "")}>
        {agentLabel(agent)}
      </button>
    );
  }
  return (
    <Field label={t("settings.agents.name")}>
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void save(value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save(value);
          if (e.key === "Escape") setValue(null);
        }}
      />
    </Field>
  );
}
