"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Banner,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Field,
  HelpButton,
  Icon,
  MonoTag,
  PageTitle,
  Select,
} from "@/design";
import { useAgentAccounts } from "@/features/agent-accounts/hooks";
import { agentAddress, agentLabel } from "@/features/agent-accounts/label";
import { useActiveOrg } from "@/features/orgs/active-org";
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
export function PairScreen() {
  const params = useSearchParams();
  const code = params.get("code")?.trim() ?? "";
  const approve = useApproveDevice();
  const [denied, setDenied] = useState(false);
  const [picked, setPicked] = useState<{ orgId: string | null; agentUserId: string }>({
    orgId: null,
    agentUserId: AS_MYSELF,
  });

  const { user } = useAuth();
  const { activeOrg } = useActiveOrg();
  const isOrgAdmin = activeOrg?.role === "owner" || activeOrg?.role === "admin";
  const agentsQ = useAgentAccounts(isOrgAdmin ? (activeOrg?.id ?? null) : null);
  const agents = agentsQ.data ?? [];

  const approved = approve.data?.approved === true;
  const activeOrgId = activeOrg?.id ?? null;
  const asAgent = picked.orgId === activeOrgId ? picked.agentUserId : AS_MYSELF;
  const chosen = agents.find((a) => a.userId === asAgent);
  const identity = chosen?.userId ?? null;

  const orgResolved = activeOrg != null;
  const waiting = !orgResolved || (isOrgAdmin && agentsQ.isLoading);

  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col gap-4 px-6 py-8">
      <div className="flex items-center justify-between gap-3">
        <PageTitle className="fg-h2">Approve a device</PageTitle>
        <HelpButton
          summary="A device running `forge-runner setup` (or `login`) is asking to pair with your account. Confirm the code matches what the CLI printed, then approve. Approving mints a device-scoped token the runner uses to accept jobs."
          actions={[
            "Approve — bind this pairing code to your account",
            "Deny — ignore the request (the code expires on its own)",
          ]}
        />
      </div>

      {!code ? (
        <Card>
          <CardContent>
            <EmptyState
              title="No pairing code"
              message="Open this page from the link printed by `forge-runner setup`, or paste a code into the CLI."
            />
          </CardContent>
        </Card>
      ) : approved ? (
        <Card>
          <CardHeader>
            <CardTitle>Device approved</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-3">
              <Banner tone="success">
                Return to your terminal — the runner will finish pairing automatically.
              </Banner>
              {chosen && (
                <Banner tone="attention">
                  Paired as {agentLabel(chosen)} ({agentAddress(chosen)}). Everything this box files
                  is filed as that agent.
                </Banner>
              )}
              {approve.data?.device && (
                <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-1.5 text-13">
                  <dt className="text-muted">Label</dt>
                  <dd className="text-fg">{approve.data.device.label}</dd>
                  <dt className="text-muted">Platform</dt>
                  <dd className="text-fg">{approve.data.device.platform}</dd>
                  {approve.data.device.hostname && (
                    <>
                      <dt className="text-muted">Hostname</dt>
                      <dd className="text-fg">{approve.data.device.hostname}</dd>
                    </>
                  )}
                </dl>
              )}
            </div>
          </CardContent>
        </Card>
      ) : denied ? (
        <Card>
          <CardContent>
            <EmptyState
              title="Request denied"
              message="The pairing code was not approved. It will expire on its own. You can close this tab."
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Pairing request</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-4">
              <p className="fg-body-sm text-muted">
                Confirm this code matches what <MonoTag>forge-runner setup</MonoTag> printed in
                your terminal before approving.
              </p>
              <div className="flex items-center justify-center rounded-lg border border-line bg-sunken py-5">
                <span className="font-mono text-2xl font-semibold tracking-[0.25em] text-fg">
                  {code}
                </span>
              </div>

              {isOrgAdmin && (
                <Field
                  label="Pair this device as"
                  hint="Paired as an agent, the box reaches that agent's projects. Paired as you, it reaches none — it can run the daemon and nothing project-scoped."
                >
                  <Select
                    value={asAgent}
                    onChange={(v) => setPicked({ orgId: activeOrgId, agentUserId: v })}
                    disabled={agentsQ.isLoading}
                    options={[
                      { value: AS_MYSELF, label: `Me — ${user?.email ?? "this account"}` },
                      ...agents.map((a) => ({
                        value: a.userId,
                        label: `${agentLabel(a)} (${agentAddress(a)})`,
                      })),
                    ]}
                  />
                </Field>
              )}

              {waiting && (
                <Banner tone="info">
                  Looking for the agents you could pair this box as — approving waits until the
                  choice is on screen.
                </Banner>
              )}
              {isOrgAdmin && agentsQ.isError && (
                <Banner
                  tone="danger"
                  action={
                    <Button variant="secondary" onClick={() => agentsQ.refetch()}>
                      Try again
                    </Button>
                  }
                >
                  The agents of this organization could not be loaded, so there is nothing to pick
                  from yet. Approving now pairs the box as you.
                </Banner>
              )}
              {isOrgAdmin && !agentsQ.isLoading && !agentsQ.isError && agents.length === 0 && (
                <Banner tone="info">
                  This organization has no agents yet. Make one in Settings → Agents to give a box
                  an identity of its own.
                </Banner>
              )}

              <Banner tone={chosen ? "attention" : "info"}>
                {chosen
                  ? `This box will act as ${agentLabel(chosen)} (${agentAddress(chosen)}) — not as you — and reach that agent's ${chosen.projects.length} project(s).`
                  : "This box will act as you. Its credential reaches no project: it can run the daemon, not read or write a project's work."}
              </Banner>

              {approve.isError && <Banner tone="danger">{formatApiError(approve.error)}</Banner>}

              <div className="flex items-center justify-end gap-2">
                <Button variant="ghost" icon="x" onClick={() => setDenied(true)}>
                  Deny
                </Button>
                <Button
                  variant="primary"
                  icon="check"
                  disabled={waiting}
                  loading={approve.isPending}
                  onClick={() =>
                    approve.mutate({ pairingCode: code, agentUserId: identity })
                  }
                >
                  Approve device
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <p className="fg-body-sm flex items-center gap-1.5 text-subtle">
        <Icon name="lock" size={13} />
        Only approve devices you started yourself. Pairing codes expire 10 minutes after creation.
      </p>
    </div>
  );
}
