"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Banner, Button, EmptyState, enumLabel, Field, HelpButton, Icon, MonoTag, PageTitle, Property, PropertyList, Section, Select, TopBarActions } from "@/design";
import { agentAddress, agentLabel, useAgentAccounts } from "@/features/agent-accounts";
import { useActiveOrg } from "@/features/orgs";
import { isOrgAdmin } from "@/features/projects";
import { formatApiError } from "@/lib/api/error";
import { useAuth } from "@/providers/auth-provider";
import { useApproveDevice } from "../hooks";

/** The value the picker carries for "this box is mine", which is not an agent id. */
const AS_MYSELF = "";

/**
 * `/pair` — the browser approval step of the runner device-login flow. The CLI
 * (`forge-runner login`) opens this page with `?code=XXX`; the signed-in user
 * confirms, binding the pending device-login code to their account. After
 * approval the CLI's poll loop receives the device token.
 *
 * An org admin may instead pair the box as one of their organization's AGENTS
 * (ISS-1093): the credential then belongs to the agent account, is fenced to
 * that agent's projects, and everything the box files is filed as the agent.
 */
type AgentAccount = ReturnType<typeof useAgentAccounts>["data"] extends (infer A)[] | undefined ? A : never;

export function PairScreen() {
  const code = useSearchParams().get("code")?.trim() ?? "";
  const approve = useApproveDevice();
  const [denied, setDenied] = useState(false);
  const [picked, setPicked] = useState<{ orgId: string | null; agentUserId: string }>({ orgId: null, agentUserId: AS_MYSELF });
  const { activeOrg } = useActiveOrg();
  const orgAdmin = isOrgAdmin(activeOrg?.role);
  const agentsQ = useAgentAccounts(orgAdmin ? (activeOrg?.id ?? null) : null);
  const activeOrgId = activeOrg?.id ?? null;
  const asAgent = picked.orgId === activeOrgId ? picked.agentUserId : AS_MYSELF;
  const chosen = (agentsQ.data ?? []).find((a) => a.userId === asAgent);

  return (
    <div className="mx-auto flex w-full max-w-140 flex-col gap-4 px-6 py-8">
      <PageTitle>Approve a device</PageTitle>
      <TopBarActions>
        <HelpButton
          summary="A device running `forge-runner setup` (or `login`) is asking to pair with your account. Confirm the code matches what the CLI printed, then approve. Approving mints a device-scoped token the runner uses to accept jobs."
          actions={["Approve — bind this pairing code to your account", "Deny — ignore the request (the code expires on its own)"]}
        />
      </TopBarActions>
      {!code ? (
        <EmptyState title="No pairing code" message="Open this page from the link printed by `forge-runner setup` or `forge-runner login`." />
      ) : approve.data?.approved === true ? (
        <PairApproved chosen={chosen} device={approve.data.device} />
      ) : denied ? (
        <EmptyState title="Request denied" message="The pairing code was not approved. It will expire on its own. You can close this tab." />
      ) : (
        <PairRequest
          code={code}
          orgAdmin={orgAdmin}
          orgResolved={activeOrg != null}
          agentsQ={agentsQ}
          asAgent={asAgent}
          chosen={chosen}
          onPick={(v) => setPicked({ orgId: activeOrgId, agentUserId: v })}
          onDeny={() => setDenied(true)}
          approve={approve}
        />
      )}
      <p className="fg-body-sm flex items-center gap-1.5 text-subtle">
        <Icon name="lock" size={13} />
        Only approve devices you started yourself.
      </p>
    </div>
  );
}

function PairApproved({ chosen, device }: { chosen: AgentAccount | undefined; device: { label: string; platform: string; hostname?: string | null } | null | undefined }) {
  return (
    <Section title="Device approved">
      <div className="flex flex-col gap-3">
        <Banner tone="success">Return to your terminal — the runner will finish pairing automatically.</Banner>
        {chosen && (
          <Banner tone="attention">
            Paired as {agentLabel(chosen)} ({agentAddress(chosen)}). Everything this box files is filed as that agent.
          </Banner>
        )}
        {device && (
          <PropertyList>
            <Property label="Label">{device.label}</Property>
            <Property label="Platform">{enumLabel("platform", device.platform)}</Property>
            {device.hostname ? <Property label="Hostname">{device.hostname}</Property> : null}
          </PropertyList>
        )}
      </div>
    </Section>
  );
}

function PairRequest({
  code,
  orgAdmin,
  orgResolved,
  agentsQ,
  asAgent,
  chosen,
  onPick,
  onDeny,
  approve,
}: {
  code: string;
  orgAdmin: boolean;
  orgResolved: boolean;
  agentsQ: ReturnType<typeof useAgentAccounts>;
  asAgent: string;
  chosen: AgentAccount | undefined;
  onPick: (agentUserId: string) => void;
  onDeny: () => void;
  approve: ReturnType<typeof useApproveDevice>;
}) {
  const { user } = useAuth();
  const agents = agentsQ.data ?? [];
  const waiting = !orgResolved || (orgAdmin && agentsQ.isLoading);
  return (
    <Section title="Pairing request">
      <div className="flex flex-col gap-4">
        <p className="fg-body-sm text-muted">
          Confirm this code matches what <MonoTag>forge-runner setup</MonoTag> printed in your terminal before approving.
        </p>
        <div className="flex items-center justify-center border-y border-line py-5">
          <span className="font-mono text-24 font-semibold tracking-widest text-fg">{code}</span>
        </div>
        {orgAdmin && (
          <Field label="Pair this device as">
            <Select
              value={asAgent}
              onChange={onPick}
              disabled={agentsQ.isLoading}
              options={[
                { value: AS_MYSELF, label: `Me — ${user?.email ?? "this account"}` },
                ...agents.map((a) => ({ value: a.userId, label: `${agentLabel(a)} (${agentAddress(a)})` })),
              ]}
            />
          </Field>
        )}
        {waiting && <Banner tone="info">Looking for the agents you could pair this box as — approving waits until the choice is on screen.</Banner>}
        {orgAdmin && agentsQ.isError && (
          <Banner
            tone="danger"
            action={
              <Button variant="secondary" onClick={() => void agentsQ.refetch()}>
                Try again
              </Button>
            }
          >
            The agents of this organization could not be loaded, so there is nothing to pick from yet. Approving now pairs the box as you.
          </Banner>
        )}
        {orgAdmin && !agentsQ.isLoading && !agentsQ.isError && agents.length === 0 && (
          <Banner tone="info">This organization has no agents yet. Make one in Settings → Agents to give a box an identity of its own.</Banner>
        )}
        <Banner tone={chosen ? "attention" : "info"}>
          {chosen
            ? `This box will act as ${agentLabel(chosen)} (${agentAddress(chosen)}) — not as you — and reach that agent's ${chosen.projects.length} project(s).`
            : "This box will act as you. Its credential reaches no project: it can run the daemon, not read or write a project's work."}
        </Banner>
        {approve.isError && <Banner tone="danger">{formatApiError(approve.error)}</Banner>}
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" icon="x" onClick={onDeny}>
            Deny
          </Button>
          <Button variant="primary" icon="check" disabled={waiting} loading={approve.isPending} onClick={() => approve.mutate({ pairingCode: code, agentUserId: chosen?.userId ?? null })}>
            Approve device
          </Button>
        </div>
      </div>
    </Section>
  );
}
