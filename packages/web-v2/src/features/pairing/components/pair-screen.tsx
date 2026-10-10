"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Banner, Button, EmptyState, enumLabel, Field, Icon, PageTitle, Property, PropertyList, Section, Select } from "@/design";
import { agentAddress, agentLabel } from "@/features/agent-accounts";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { useApproveDevice, usePairIdentities } from "../hooks";

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
type AgentsRead = ReturnType<typeof usePairIdentities>["agentsQ"];
type AgentAccount = AgentsRead["data"] extends (infer A)[] | undefined ? A : never;

export function PairScreen() {
  const t = useCopy();
  const code = useSearchParams().get("code")?.trim() ?? "";
  const approve = useApproveDevice();
  const [denied, setDenied] = useState(false);
  const [picked, setPicked] = useState<{ orgId: string | null; agentUserId: string }>({ orgId: null, agentUserId: AS_MYSELF });
  const { user, activeOrg, orgAdmin, agentsQ } = usePairIdentities();
  const activeOrgId = activeOrg?.id ?? null;
  const asAgent = picked.orgId === activeOrgId ? picked.agentUserId : AS_MYSELF;
  const chosen = (agentsQ.data ?? []).find((a) => a.userId === asAgent);

  return (
    <div className="mx-auto flex w-full max-w-140 flex-col gap-4 px-6 py-8">
      <PageTitle>{t("pairing.title")}</PageTitle>
      {!code ? (
        <EmptyState message={t("pairing.noCode")} />
      ) : approve.data?.approved === true ? (
        <PairApproved chosen={chosen} device={approve.data.device} />
      ) : denied ? (
        <EmptyState message={t("pairing.denied")} />
      ) : (
        <PairRequest
          code={code}
          orgAdmin={orgAdmin}
          orgResolved={activeOrg != null}
          agentsQ={agentsQ}
          user={user}
          asAgent={asAgent}
          chosen={chosen}
          onPick={(v) => setPicked({ orgId: activeOrgId, agentUserId: v })}
          onDeny={() => setDenied(true)}
          approve={approve}
        />
      )}
      <p className="fg-body-sm flex items-center gap-1.5 text-subtle">
        <Icon name="lock" size={13} />
        {t("pairing.ownOnly")}
      </p>
    </div>
  );
}

function PairApproved({ chosen, device }: { chosen: AgentAccount | undefined; device: { label: string; platform: string; hostname?: string | null } | null | undefined }) {
  const t = useCopy();
  return (
    <Section title={t("pairing.approved.title")}>
      <div className="flex flex-col gap-3">
        <Banner tone="success">{t("pairing.approved.back")}</Banner>
        {chosen && <Banner tone="attention">{t("pairing.approved.as", { name: agentLabel(chosen), address: agentAddress(chosen) })}</Banner>}
        {device && (
          <PropertyList>
            <Property label={t("pairing.device.label")}>{device.label}</Property>
            <Property label={t("pairing.device.platform")}>{enumLabel("platform", device.platform)}</Property>
            {device.hostname ? <Property label={t("pairing.device.hostname")}>{device.hostname}</Property> : null}
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
  user,
  asAgent,
  chosen,
  onPick,
  onDeny,
  approve,
}: {
  code: string;
  orgAdmin: boolean;
  orgResolved: boolean;
  agentsQ: AgentsRead;
  user: ReturnType<typeof usePairIdentities>["user"];
  asAgent: string;
  chosen: AgentAccount | undefined;
  onPick: (agentUserId: string) => void;
  onDeny: () => void;
  approve: ReturnType<typeof useApproveDevice>;
}) {
  const t = useCopy();
  const agents = agentsQ.data ?? [];
  const waiting = !orgResolved || (orgAdmin && agentsQ.isLoading);
  return (
    <Section title={t("pairing.request.title")}>
      <div className="flex flex-col gap-4">
        <p className="fg-body-sm text-muted">{t("pairing.request.check")}</p>
        <div className="flex items-center justify-center border-y border-line py-5">
          <span className="font-mono text-24 font-semibold tracking-widest text-fg">{code}</span>
        </div>
        {orgAdmin && (
          <Field label={t("pairing.pairAs")}>
            <Select
              value={asAgent}
              onChange={onPick}
              disabled={agentsQ.isLoading}
              options={[
                { value: AS_MYSELF, label: t("pairing.asMe", { email: user?.email ?? t("pairing.thisAccount") }) },
                ...agents.map((a) => ({ value: a.userId, label: `${agentLabel(a)} (${agentAddress(a)})` })),
              ]}
            />
          </Field>
        )}
        {waiting && <Banner tone="info">{t("pairing.agentsLoading")}</Banner>}
        {orgAdmin && agentsQ.isError && (
          <Banner
            tone="danger"
            action={
              <Button variant="secondary" onClick={() => void agentsQ.refetch()}>
                {t("pairing.retry")}
              </Button>
            }
          >
            {t("pairing.agentsFailed")}
          </Banner>
        )}
        {orgAdmin && !agentsQ.isLoading && !agentsQ.isError && agents.length === 0 && (
          <Banner tone="info">{t("pairing.noAgents")}</Banner>
        )}
        <Banner tone={chosen ? "attention" : "info"}>
          {chosen
            ? t("pairing.actsAsAgent", { name: agentLabel(chosen), address: agentAddress(chosen), n: chosen.projects.length })
            : t("pairing.actsAsYou")}
        </Banner>
        {approve.isError && <Banner tone="danger">{formatApiError(approve.error)}</Banner>}
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" icon="x" onClick={onDeny}>
            {t("pairing.deny")}
          </Button>
          <Button variant="primary" icon="check" disabled={waiting} loading={approve.isPending} onClick={() => approve.mutate({ pairingCode: code, agentUserId: chosen?.userId ?? null })}>
            {t("pairing.approve")}
          </Button>
        </div>
      </div>
    </Section>
  );
}
