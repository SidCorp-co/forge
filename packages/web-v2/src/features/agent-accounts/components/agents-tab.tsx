"use client";

// Settings → Agents. An org admin's view of the agent accounts in their
// organization: what each one is called, what it is addressed as, whether it
// can act at all, and the two verbs that change that.
//
// The population this exists for is the handles a conversation mints. Those get
// a name in a room and NO token by design, so they were permanently unable to
// answer and there was no surface anywhere in the product that could give them
// one — the three routes behind it had no caller (ISS-1003).

import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardTitle,
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

  const [revealed, setRevealed] = useState<{ userId: string; plaintext: string } | null>(null);
  const [renaming, setRenaming] = useState<{ userId: string; value: string } | null>(null);

  if (activeOrg && activeOrg.role !== "owner" && activeOrg.role !== "admin") {
    return (
      <EmptyState
        title="Agents are managed by an org admin"
        message="Ask an owner or admin of this organization to give an agent a credential."
      />
    );
  }

  if (!orgId || agentsQ.isLoading) return <Skeleton className="h-40 w-full" />;
  if (agentsQ.isError) {
    return <ErrorState title="Could not load agents" message={formatApiError(agentsQ.error)} />;
  }

  const agents = agentsQ.data ?? [];

  async function onMint(agent: AgentAccountRow) {
    try {
      const { plaintext } = await mint.mutateAsync(agent.userId);
      setRevealed({ userId: agent.userId, plaintext });
    } catch (err) {
      toast({ title: "Could not mint a credential", description: formatApiError(err), tone: "error" });
    }
  }

  async function onRevoke(agent: AgentAccountRow) {
    try {
      const { revoked } = await revoke.mutateAsync(agent.userId);
      if (revealed?.userId === agent.userId) setRevealed(null);
      toast({
        title: revoked === 0 ? "It held no live credential" : `Revoked ${revoked} credential(s)`,
        description: `${agentLabel(agent)} keeps its place in every room it is in, and now shows as unreachable.`,
        tone: "success",
      });
    } catch (err) {
      toast({ title: "Could not revoke", description: formatApiError(err), tone: "error" });
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
      toast({ title: "Could not set the name", description: formatApiError(err), tone: "error" });
    }
  }

  const nameOf = (projectId: string) => projects.find((p) => p.id === projectId)?.name;
  const openAgent = selfOpen ? agents.find((a) => a.userId === selfOpen) : undefined;
  return (
    <div className="space-y-6">
      <header>
        <SectionTitle className="fg-h3">Agents in {activeOrg?.name ?? "this organization"}</SectionTitle>
        <p className="fg-body-sm mt-1">
          An agent is addressed by its handle and read by its name. It can only act while it holds a
          credential.
        </p>
      </header>

      {revealed && (
        <Card>
          <CardContent>
            <CardTitle className="mb-2">Copy this now — it is shown once</CardTitle>
            <p className="fg-body-sm mb-3">
              Forge stores a hash of it, so there is nothing to read back. Losing it means minting
              another.
            </p>
            <MonoTag>{revealed.plaintext}</MonoTag>
            <div className="mt-3 flex gap-2">
              <Button
                variant="secondary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(revealed.plaintext);
                    toast({ title: "Copied to clipboard", tone: "success" });
                  } catch {
                    toast({
                      title: "Copy failed",
                      description: "Select and copy it by hand.",
                      tone: "error",
                    });
                  }
                }}
              >
                Copy
              </Button>
              <Button variant="ghost" onClick={() => setRevealed(null)}>
                I have it
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <CreateAgentForm orgId={orgId} />

      {agents.length === 0 ? (
        <EmptyState
          title="No agents yet"
          message="Create one above, or let one appear when a project is first spoken to in a room."
        />
      ) : (
        <Card>
          <CardContent>
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Address</TH>
                  <TH>Projects</TH>
                  <TH>Can act</TH>
                  <TH aria-label="Actions" />
                </TR>
              </THead>
              <TBody>
                {agents.map((agent) => {
                  const reach = reachOf(agent);
                  return (
                    <TR key={agent.userId}>
                      <TD>
                        {renaming?.userId === agent.userId ? (
                          <Field label="Name" hint="Free text. Nothing resolves against it.">
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
                      <TD>{agentProjectNames(agent, nameOf)}</TD>
                      <TD>
                        {reach.canAct ? (
                          <Badge tone="green">Yes</Badge>
                        ) : (
                          <div>
                            <Badge tone="amber">No — {reach.why}</Badge>
                            <p className="fg-body-sm mt-1">{reach.remedy}</p>
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
                            {agent.activeTokens > 0 ? "Mint another" : "Give a credential"}
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={busy || agent.activeTokens === 0}
                            onClick={() => onRevoke(agent)}
                          >
                            Revoke
                          </Button>
                          <Button
                            variant="ghost"
                            aria-expanded={selfOpen === agent.userId}
                            onClick={() =>
                              setSelfOpen(selfOpen === agent.userId ? null : agent.userId)
                            }
                          >
                            {selfOpen === agent.userId ? "Close self" : "Self"}
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
                <CardTitle className="mb-3">Self of {agentLabel(openAgent)}</CardTitle>
                <AgentSelfEditor
                  orgId={orgId}
                  agentUserId={openAgent.userId}
                  handle={agentAddress(openAgent)}
                />
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
