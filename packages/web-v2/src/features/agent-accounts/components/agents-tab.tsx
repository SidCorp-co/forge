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
  DataTable,
  type DataTableColumn,
  EmptyState,
  ErrorState,
  Field,
  Input,
  MonoTag,
  RowActions,
  SectionTitle,
  Skeleton,
} from "@/design";
import { useActiveOrg } from "@/features/orgs/active-org";
import { useProjectsIncludingArchived } from "@/features/projects/hooks";
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
  const projectsQ = useProjectsIncludingArchived();
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

  const nameOf = (projectId: string) => projectsQ.data?.find((p) => p.id === projectId)?.name;
  const openAgent = selfOpen ? agents.find((a) => a.userId === selfOpen) : undefined;

  const columns: DataTableColumn<AgentAccountRow>[] = [
    {
      id: "name",
      header: "Name",
      sticky: true,
      cellClassName: "whitespace-nowrap",
      sortValue: (agent) => agentLabel(agent),
      cell: (agent) =>
        renaming?.userId === agent.userId ? (
          <Field label="Name" hint="Free text. Nothing resolves against it.">
            <Input
              value={renaming.value}
              autoFocus
              onChange={(e) => setRenaming({ userId: agent.userId, value: e.target.value })}
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
            onClick={() => setRenaming({ userId: agent.userId, value: agent.displayName ?? "" })}
          >
            {agentLabel(agent)}
          </button>
        ),
    },
    {
      id: "address",
      header: "Address",
      sortValue: (agent) => agent.handle,
      cell: (agent) => <MonoTag>{agentAddress(agent)}</MonoTag>,
    },
    {
      id: "projects",
      header: "Projects",
      cell: (agent) => agentProjectNames(agent, nameOf, projectsQ.isLoading),
    },
    {
      id: "canAct",
      header: "Can act",
      cellClassName: "whitespace-nowrap",
      sortValue: (agent) => (agent.canAct ? 1 : 0),
      cell: (agent) => {
        const reach = reachOf(agent);
        return reach.canAct ? <Badge tone="green">Yes</Badge> : <Badge tone="amber">No — {reach.why}</Badge>;
      },
    },
    {
      id: "actions",
      header: null,
      headerLabel: "Actions",
      align: "end",
      cell: (agent) => (
        <RowActions
          subject={agentLabel(agent)}
          busy={busy}
          actions={[
            { id: "give", label: "Give a credential", onClick: () => onMint(agent) },
            agent.activeTokens > 0 && {
              id: "revoke",
              label: "Revoke",
              variant: "ghost",
              onClick: () => onRevoke(agent),
            },
            {
              id: "self",
              label: selfOpen === agent.userId ? "Close self" : "Self",
              variant: "ghost",
              expanded: selfOpen === agent.userId,
              onClick: () => setSelfOpen(selfOpen === agent.userId ? null : agent.userId),
            },
          ]}
        />
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <header>
        <SectionTitle className="fg-h3">Agents in {activeOrg?.name ?? "this organization"}</SectionTitle>
        <p className="fg-body-sm mt-1">
          An agent is addressed by its handle and read by its name. It can act only while it belongs to
          a project and holds a live credential, and without one it cannot answer in a room. Giving a
          credential adds one and does not replace the one an agent already holds: revoke that
          separately.
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

      {agents.length === 0 ? (
        <EmptyState
          title="No agents yet"
          message="Create one below, or let one appear when a project is first spoken to in a room."
        />
      ) : (
        <>
          <DataTable
            aria-label="Agents"
            rows={agents}
            columns={columns}
            getRowId={(agent) => agent.userId}
          />
          {openAgent && (
            <div className="border-t border-line pt-6">
              <CardTitle className="mb-3">Self of {agentLabel(openAgent)}</CardTitle>
              <AgentSelfEditor
                orgId={orgId}
                agentUserId={openAgent.userId}
                handle={agentAddress(openAgent)}
              />
            </div>
          )}
        </>
      )}

      <CreateAgentForm orgId={orgId} />
    </div>
  );
}
