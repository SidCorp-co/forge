"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Banner,
  Button,
  PageSection,
  PageSectionBody,
  PageSectionHeader,
  PageSectionTitle,
  EmptyState,
  Field,
  Icon,
  PageTitle,
  Select,
  enumLabel,
} from "@/design";
import { agentAddress, agentLabel } from "@/features/agent-accounts/label";
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
export function PairScreen() {
  const t = useCopy();
  const params = useSearchParams();
  const code = params.get("code")?.trim() ?? "";
  const approve = useApproveDevice();
  const [denied, setDenied] = useState(false);
  const [picked, setPicked] = useState<{ orgId: string | null; agentUserId: string }>({
    orgId: null,
    agentUserId: AS_MYSELF,
  });

  const { user, activeOrg, orgAdmin, agentsQ } = usePairIdentities();
  const agents = agentsQ.data ?? [];

  const approved = approve.data?.approved === true;
  const activeOrgId = activeOrg?.id ?? null;
  const asAgent = picked.orgId === activeOrgId ? picked.agentUserId : AS_MYSELF;
  const chosen = agents.find((a) => a.userId === asAgent);
  const identity = chosen?.userId ?? null;

  const orgResolved = activeOrg != null;
  const waiting = !orgResolved || (orgAdmin && agentsQ.isLoading);

  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col gap-4 px-6 py-8">
      <PageTitle>{t("pairing.title")}</PageTitle>

      {!code ? (
        <PageSection>
          <PageSectionBody>
            <EmptyState message={t("pairing.noCode")} />
          </PageSectionBody>
        </PageSection>
      ) : approved ? (
        <PageSection>
          <PageSectionHeader>
            <PageSectionTitle>{t("pairing.approved.title")}</PageSectionTitle>
          </PageSectionHeader>
          <PageSectionBody>
            <div className="flex flex-col gap-3">
              <Banner tone="success">{t("pairing.approved.back")}</Banner>
              {chosen && (
                <Banner tone="attention">
                  {t("pairing.approved.as", { name: agentLabel(chosen), address: agentAddress(chosen) })}
                </Banner>
              )}
              {approve.data?.device && (
                <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-1.5 text-13">
                  <dt className="text-muted">{t("pairing.device.label")}</dt>
                  <dd className="text-fg">{approve.data.device.label}</dd>
                  <dt className="text-muted">{t("pairing.device.platform")}</dt>
                  <dd className="text-fg">{enumLabel("platform", approve.data.device.platform)}</dd>
                  {approve.data.device.hostname && (
                    <>
                      <dt className="text-muted">{t("pairing.device.hostname")}</dt>
                      <dd className="text-fg">{approve.data.device.hostname}</dd>
                    </>
                  )}
                </dl>
              )}
            </div>
          </PageSectionBody>
        </PageSection>
      ) : denied ? (
        <PageSection>
          <PageSectionBody>
            <EmptyState message={t("pairing.denied")} />
          </PageSectionBody>
        </PageSection>
      ) : (
        <PageSection>
          <PageSectionHeader>
            <PageSectionTitle>{t("pairing.request.title")}</PageSectionTitle>
          </PageSectionHeader>
          <PageSectionBody>
            <div className="flex flex-col gap-4">
              <p className="fg-body-sm text-muted">{t("pairing.request.check")}</p>
              <div className="flex items-center justify-center rounded-lg border border-line bg-sunken py-5">
                <span className="font-mono text-2xl font-semibold tracking-[0.25em] text-fg">
                  {code}
                </span>
              </div>

              {orgAdmin && (
                <Field label={t("pairing.pairAs")}>
                  <Select
                    value={asAgent}
                    onChange={(v) => setPicked({ orgId: activeOrgId, agentUserId: v })}
                    disabled={agentsQ.isLoading}
                    options={[
                      { value: AS_MYSELF, label: t("pairing.asMe", { email: user?.email ?? t("pairing.thisAccount") }) },
                      ...agents.map((a) => ({
                        value: a.userId,
                        label: `${agentLabel(a)} (${agentAddress(a)})`,
                      })),
                    ]}
                  />
                </Field>
              )}

              {waiting && (
                <Banner tone="info">{t("pairing.agentsLoading")}</Banner>
              )}
              {orgAdmin && agentsQ.isError && (
                <Banner
                  tone="danger"
                  action={
                    <Button variant="secondary" onClick={() => agentsQ.refetch()}>
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
                <Button variant="ghost" icon="x" onClick={() => setDenied(true)}>
                  {t("pairing.deny")}
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
                  {t("pairing.approve")}
                </Button>
              </div>
            </div>
          </PageSectionBody>
        </PageSection>
      )}

      <p className="fg-body-sm flex items-center gap-1.5 text-subtle">
        <Icon name="lock" size={13} />
        {t("pairing.ownOnly")}
      </p>
    </div>
  );
}
