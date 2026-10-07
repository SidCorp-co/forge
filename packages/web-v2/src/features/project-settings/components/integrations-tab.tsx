"use client";

// Project settings → Integrations — the FULL per-project management surface
// (ISS-429): the integrations table with config/Test/Rotate/Disconnect drill-in,
// the Agent MCP servers preview, and the ISS-408/F3 "Share an existing
// connection" section. The workspace `/integrations` page is the owner-scoped
// connection directory; everything project-scoped lives here.
import { useMemo, useState } from "react";
import { Banner, Button, PageSection, PageSectionBody, PageSectionTitle, Field, Select, type SelectOption } from "@/design";
import {
  AGENT_ACCESS_CLOSED,
  AgentAccessChoice,
  agentAccessBody,
  agentAccessDeniedReason,
  mayWriteAgentAccess,
} from "@/features/integrations/components/agent-access-control";
import { ProjectIntegrationsPanel } from "@/features/integrations/components/project-integrations-panel";
import { TourHint } from "@/features/tours/components/tour-hint";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { useBindConnection, useConnections, useIsOrgAdmin } from "@/features/integrations/hooks";
import { providerLabel, providerModule } from "@/features/integrations/providers/registry";
import { bindingRefusalText } from "@/features/integrations/bind-actions";
import { coolify } from "@/features/integrations/providers/coolify";
import { CoolifyTargetsField } from "@/features/integrations/providers/coolify/targets-field";
import { providerCanDeploy } from "@forge/contracts/deploy-capability";
import type {
  AgentAccess,
  BindingRole,
  ConnectionSummary,
  CoolifyTargetInput,
} from "@/features/integrations/types";

// What the binding is FOR — DECLARED by the person, never derived from the
// provider: the same epodsystem connection is a deploy target on a storefront
// project and a plain service on one that only borrows its MCP.
function roleOptions(t: Copy): SelectOption[] {
  return [
    { value: "service", label: t("integrations.form.roleService") },
    { value: "deploy", label: t("integrations.form.roleDeploy") },
  ];
}

function connectionLabel(c: ConnectionSummary, language: string): string {
  const provider = providerLabel(c.provider, language);
  return c.displayName ? `${c.displayName} · ${provider}` : provider;
}

const NO_APPLICATION: CoolifyTargetInput = { label: "", resourceUuid: "" };

function applicationsRefusal(targets: CoolifyTargetInput[], t: Copy): string | null {
  const incomplete = targets.findIndex((row) => !row.label.trim() || !row.resourceUuid.trim());
  if (incomplete === -1) return null;
  return targets.length === 1 && !targets[0]?.label.trim() && !targets[0]?.resourceUuid.trim()
    ? t("integrations.share.needApp")
    : t("integrations.share.appIncomplete", { n: incomplete + 1 });
}

function applicationsOf(targets: CoolifyTargetInput[]): CoolifyTargetInput[] {
  return targets.map(({ healthUrl, ...t }) => ({
    ...t,
    label: t.label.trim(),
    resourceUuid: t.resourceUuid.trim(),
    ...(healthUrl?.trim() ? { healthUrl: healthUrl.trim() } : {}),
  }));
}

function ShareExistingCard({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const connectionsQ = useConnections();
  // Only active connections with a stored credential are eligible to share —
  // a soft-deleted or secret-less row would fail server-side (loadOwnedConnection
  // rejects active=false). Filtering here keeps the picker honest.
  const eligible = useMemo(
    () => (connectionsQ.data?.items ?? []).filter((c) => c.active && c.hasSecrets),
    [connectionsQ.data],
  );
  const t = useCopy();
  return (
    <PageSection data-tour="int-share">
      <PageSectionBody style={{ paddingTop: 0 }}>
        <PageSectionTitle className="mb-1">{t("integrations.share.title")}</PageSectionTitle>
        <p className="fg-body-sm mb-4 max-w-[72ch] text-muted">{t("integrations.share.intro")}</p>
        {!canEdit ? (
          <Banner tone="info">{t("integrations.share.ownerOnly")}</Banner>
        ) : !connectionsQ.isLoading && eligible.length === 0 ? (
          <Banner tone="info">{t("integrations.share.none")}</Banner>
        ) : (
          <ShareForm projectId={projectId} eligible={eligible} loading={connectionsQ.isLoading} />
        )}
      </PageSectionBody>
    </PageSection>
  );
}

function ShareForm({
  projectId,
  eligible,
  loading,
}: {
  projectId: string;
  eligible: ConnectionSummary[];
  loading: boolean;
}) {
  const bind = useBindConnection(projectId);
  const isOrgAdmin = useIsOrgAdmin(projectId);
  const [connectionId, setConnectionId] = useState<string>("");
  const [role, setRole] = useState<BindingRole>("service");
  const [agentAccess, setAgentAccess] = useState<AgentAccess>(AGENT_ACCESS_CLOSED);
  const [applications, setApplications] = useState<CoolifyTargetInput[]>([NO_APPLICATION]);
  const [formError, setFormError] = useState<string | null>(null);
  const t = useCopy();
  const language = useInterfaceLanguage();

  const selected = eligible.find((c) => c.id === connectionId);
  const provider = selected?.provider;
  const canDeploy = provider === undefined ? true : providerCanDeploy(provider);
  const namesApplications = provider === coolify.provider;
  const providerName = provider ? providerLabel(provider, language) : t("integrations.share.thisProvider");
  // No binding exists yet, so the risk class comes off the provider's own module. `none` renders no
  // control at all — that provider has no agent path for a grant to open.
  const agentPathKind = provider ? (providerModule(provider)?.agentPathKind ?? "none") : "none";

  function submit() {
    if (!connectionId) return;
    if (role === "deploy" && !canDeploy) {
      setFormError(t("integrations.share.cannotDeployPick", { provider: providerName }));
      return;
    }
    if (!selected) return;
    const missing = namesApplications ? applicationsRefusal(applications, t) : null;
    setFormError(missing);
    if (missing) return;
    bind.mutate(
      {
        connectionId,
        provider: selected.provider,
        role,
        binding: namesApplications ? { targets: applicationsOf(applications) } : {},
        ...agentAccessBody(agentPathKind, agentAccess),
      },
      {
        onSuccess: () => {
          setConnectionId("");
          setRole("service");
          setAgentAccess(AGENT_ACCESS_CLOSED);
          setApplications([NO_APPLICATION]);
        },
      },
    );
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <Field label={t("integrations.share.connection")} required>
        <Select
          options={eligible.map((c) => ({ value: c.id, label: connectionLabel(c, language) }))}
          value={connectionId}
          onChange={(v) => {
            setConnectionId(v);
            setApplications([NO_APPLICATION]);
            setFormError(null);
          }}
          placeholder={loading ? t("integrations.provider.loading") : t("integrations.share.select")}
          disabled={loading || bind.isPending}
        />
      </Field>
      <Field label={t("integrations.form.role")} required>
        <Select
          options={roleOptions(t)}
          value={role}
          onChange={(v) => {
            setRole(v as BindingRole);
            setFormError(null);
          }}
          disabled={!connectionId || bind.isPending}
        />
      </Field>
      {role === "deploy" && !canDeploy && (
        <Banner tone="attention">
          {t("integrations.share.cannotDeploy", { provider: providerName })}
        </Banner>
      )}
      {role === "deploy" && canDeploy && (
        <p className="fg-body-sm text-muted">
          {t("integrations.share.deployWhere.lead")} <code>environments.&lt;name&gt;.deployment.binding</code>{" "}
          {t("integrations.share.deployWhere.tail")}
        </p>
      )}
      {namesApplications && (
        <CoolifyTargetsField
          projectId={projectId}
          integrationId={undefined}
          baseUrl=""
          apiToken=""
          targets={applications}
          onChange={(next) => {
            setApplications(next);
            setFormError(null);
          }}
          inherited={false}
        />
      )}
      <AgentAccessChoice
        value={agentAccess}
        onChange={setAgentAccess}
        pathKind={agentPathKind}
        canEdit={mayWriteAgentAccess(agentPathKind, { canEditProject: true, isOrgAdmin }) && !bind.isPending}
        disabledReason={agentAccessDeniedReason(agentPathKind)}
      />
      {formError && <Banner tone="attention">{formError}</Banner>}
      {bind.isError && <Banner tone="danger">{bindingRefusalText(bind.error)}</Banner>}
      <div>
        <Button variant="primary" onClick={submit} loading={bind.isPending} disabled={!connectionId || bind.isPending}>
          {t("integrations.share.submit")}
        </Button>
      </div>
    </div>
  );
}

export function IntegrationsTab({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  return (
    <div className="flex flex-col gap-10">
      <div>
        <TourHint tourId="integrations" />
        <ProjectIntegrationsPanel projectId={projectId} canEdit={canEdit} />
      </div>
      <ShareExistingCard projectId={projectId} canEdit={canEdit} />
    </div>
  );
}
