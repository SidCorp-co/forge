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
  Badge,
  Button,
  PageSection,
  PageSectionBody,
  PageSectionTitle,
  EmptyState,
  ErrorState,
  Field,
  Input,
  MonoTag,
  SectionTitle,
  Skeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/design";
import { useActiveOrg } from "@/features/orgs/active-org";
import { useOrgScopedProjects } from "@/features/projects/hooks";
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

export function AgentsTab() {
  const [selfOpen, setSelfOpen] = useState<string | null>(null);
  const { activeOrg } = useActiveOrg();
  const orgId = activeOrg?.id ?? null;
  const agentsQ = useAgentAccounts(orgId);
  const mint = useMintAgentCredential(orgId);
  const revoke = useRevokeAgentCredentials(orgId);
  const rename = useSetAgentDisplayName(orgId);
  const { projects } = useOrgScopedProjects();
  const busy = mint.isPending || revoke.isPending;
  const { toast } = useToast();
  const t = useCopy();

  const [revealed, setRevealed] = useState<{ userId: string; plaintext: string } | null>(null);
  const [renaming, setRenaming] = useState<{ userId: string; value: string } | null>(null);

  if (activeOrg && !ORG_ROLE_PERMISSIONS[activeOrg.role].includes("org.admin")) {
    return (
      <EmptyState
        title={t("settings.agents.adminOnly")}
        message={t("settings.agents.adminOnlyBody")}
      />
    );
  }

  if (!orgId || agentsQ.isLoading) return <Skeleton className="h-40 w-full" />;
  if (agentsQ.isError) {
    return <ErrorState title={t("settings.agents.loadFailed")} message={formatApiError(agentsQ.error)} />;
  }

  const agents = agentsQ.data ?? [];

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

  async function onRename(agent: AgentAccountRow, value: string) {
    try {
      await rename.mutateAsync({
        agentUserId: agent.userId,
        displayName: value.trim() === "" ? null : value.trim(),
      });
      setRenaming(null);
    } catch (err) {
      toast({ title: t("settings.agents.nameFailed"), description: formatApiError(err), tone: "error" });
    }
  }

  const nameOf = (projectId: string) => projects.find((p) => p.id === projectId)?.name;
  const openAgent = selfOpen ? agents.find((a) => a.userId === selfOpen) : undefined;
  return (
    <div className="space-y-6">
      <header>
        <SectionTitle className="fg-h3">
          {t("settings.agents.title", { org: activeOrg?.name ?? t("settings.agents.thisOrg") })}
        </SectionTitle>
        <p className="fg-body-sm mt-1">{t("settings.agents.intro")}</p>
      </header>

      {revealed && (
        <PageSection>
          <PageSectionBody>
            <PageSectionTitle className="mb-2">{t("settings.agents.copyNow")}</PageSectionTitle>
            <p className="fg-body-sm mb-3">{t("settings.agents.hashOnly")}</p>
            <MonoTag>{revealed.plaintext}</MonoTag>
            <div className="mt-3 flex gap-2">
              <Button
                variant="secondary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(revealed.plaintext);
                    toast({ title: t("settings.agents.copied"), tone: "success" });
                  } catch {
                    toast({
                      title: t("settings.agents.copyFailed"),
                      description: t("settings.agents.copyByHand"),
                      tone: "error",
                    });
                  }
                }}
              >
                {t("settings.agents.copy")}
              </Button>
              <Button variant="ghost" onClick={() => setRevealed(null)}>
                {t("settings.agents.haveIt")}
              </Button>
            </div>
          </PageSectionBody>
        </PageSection>
      )}

      <CreateAgentForm orgId={orgId} />

      {agents.length === 0 ? (
        <EmptyState
          title={t("settings.agents.none")}
          message={t("settings.agents.noneBody")}
        />
      ) : (
        <PageSection>
          <PageSectionBody>
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
                {agents.map((agent) => {
                  const reach = reachOf(agent);
                  return (
                    <TR key={agent.userId}>
                      <TD>
                        {renaming?.userId === agent.userId ? (
                          <Field label={t("settings.agents.name")} hint={t("settings.agents.nameHint")}>
                            <Input
                              value={renaming.value}
                              autoFocus
                              onChange={(e) =>
                                setRenaming({ userId: agent.userId, value: e.target.value })
                              }
                              onBlur={() => onRename(agent, renaming.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") onRename(agent, renaming.value);
                                if (e.key === "Escape") setRenaming(null);
                              }}
                            />
                          </Field>
                        ) : (
                          <button
                            type="button"
                            className="text-left"
                            onClick={() =>
                              setRenaming({
                                userId: agent.userId,
                                value: agent.displayName ?? "",
                              })
                            }
                          >
                            {agentLabel(agent)}
                          </button>
                        )}
                      </TD>
                      <TD>
                        <MonoTag>{agentAddress(agent)}</MonoTag>
                      </TD>
                      <TD>{agentProjectNames(agent, nameOf, t("settings.agents.noProjects"))}</TD>
                      <TD>
                        {reach.canAct ? (
                          <Badge tone="green">{t("settings.agents.yes")}</Badge>
                        ) : (
                          <div>
                            <Badge tone="amber">{t("settings.agents.noWhy", { why: t(reach.why) })}</Badge>
                            <p className="fg-body-sm mt-1">{t(reach.remedy)}</p>
                          </div>
                        )}
                      </TD>
                      <TD>
                        <div className="flex gap-2">
                          <Button
                            variant="secondary"
                            disabled={busy}
                            onClick={() => onMint(agent)}
                          >
                            {agent.activeTokens > 0 ? t("settings.agents.mintAnother") : t("settings.agents.give")}
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={busy || agent.activeTokens === 0}
                            onClick={() => onRevoke(agent)}
                          >
                            {t("settings.agents.revoke")}
                          </Button>
                          <Button
                            variant="ghost"
                            aria-expanded={selfOpen === agent.userId}
                            onClick={() =>
                              setSelfOpen(selfOpen === agent.userId ? null : agent.userId)
                            }
                          >
                            {selfOpen === agent.userId ? t("settings.agents.closeSelf") : t("settings.agents.self")}
                          </Button>
                        </div>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
            {openAgent && (
              <div className="mt-6 border-t border-line pt-6">
                <PageSectionTitle className="mb-3">{t("settings.agents.selfOf", { name: agentLabel(openAgent) })}</PageSectionTitle>
                <AgentSelfEditor
                  orgId={orgId}
                  agentUserId={openAgent.userId}
                  handle={agentAddress(openAgent)}
                />
              </div>
            )}
          </PageSectionBody>
        </PageSection>
      )}
    </div>
  );
}
