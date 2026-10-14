import { Button, Field, Input, Select } from "@/design";
import { useMemo, useState } from "react";
import { useCopy } from "@/lib/i18n/interface-language";
import { AGENT_ACCESS_CLOSED, AgentAccessChoice, agentAccessBody } from "../../components/agent-access-control";
import { ConnectionOwnerField } from "../../components/connection-owner-field";
import { useBindConnection, useConnections } from "../../hooks";
import type { AgentAccess, ConnectionSummary, GitLabRepository, IntegrationSummary } from "../../types";
import { text } from "../config-read";
import { activeBadge, OrgLockedNote, ProviderSummary, TestOutcome } from "../shared";
import { SingleBindingFooter, useSingleBinding } from "../single-binding";
import { GITLAB_DEFAULT_BASE_URL, gitlab, gitlabHost } from "./index";
import { GitLabRepositoryField, gitlabBindingOf, gitlabRepositoryOf, SetGitLabRepository } from "./repository";
import { GitlabWebhook } from "./webhook-panel";

interface FormState {
  token: string;
  baseUrl: string;
}

function initialForm(existing: IntegrationSummary | undefined): FormState {
  const cfg = (existing?.config ?? {}) as { baseUrl?: unknown };
  return {
    token: "",
    baseUrl: typeof cfg.baseUrl === "string" && cfg.baseUrl ? cfg.baseUrl : GITLAB_DEFAULT_BASE_URL,
  };
}

function connectionName(c: ConnectionSummary): string {
  // the default display name already names the host
  return c.displayName ?? `GitLab · ${gitlabHost(text(c.config, "baseUrl") ?? undefined)}`;
}

/** The repository a binding reaches, with the act that changes it, or the picker where none is picked. */
function BindingRepository({ projectId, binding }: { projectId: string; binding: IntegrationSummary }) {
  const [changing, setChanging] = useState(false);
  const repo = gitlabRepositoryOf(binding.config);
  const t = useCopy();

  if (repo && !changing) {
    const base = (text(binding.config, "baseUrl") ?? GITLAB_DEFAULT_BASE_URL).replace(/\/+$/, "");
    return (
      <Field label={t("integrations.gitlab.repository")}>
        <div className="flex flex-wrap items-center gap-3" data-testid="gitlab-bound-repository">
          <a href={`${base}/${repo}`} target="_blank" rel="noreferrer" className="font-mono text-13 font-semibold text-link hover:underline">
            {gitlabHost(base)}/{repo}
          </a>
          <Button variant="ghost" size="sm" onClick={() => setChanging(true)}>
            {t("integrations.gitlab.changeRepo")}
          </Button>
        </div>
      </Field>
    );
  }
  return <SetGitLabRepository projectId={projectId} binding={binding} onDone={repo ? () => setChanging(false) : null} />;
}

/**
 * A project with no GitLab binding, where the caller already holds a GitLab connection: pick the
 * connection and one of the projects its token can push to. GitHub's "use the existing App" path.
 */
function UseExistingConnection({
  projectId,
  reusable,
  onNew,
}: {
  projectId: string;
  reusable: ConnectionSummary[];
  onNew: () => void;
}) {
  const bind = useBindConnection(projectId);
  const [connectionId, setConnectionId] = useState(reusable[0]?.id ?? "");
  const [picked, setPicked] = useState<GitLabRepository | null>(null);
  const [agentAccess, setAgentAccess] = useState<AgentAccess>(AGENT_ACCESS_CLOSED);
  const t = useCopy();

  const submit = () => {
    if (!picked || !connectionId) return;
    bind.mutate({
      connectionId,
      provider: gitlab.provider,
      role: "service",
      binding: gitlabBindingOf(picked),
      ...agentAccessBody(gitlab.agentPathKind, agentAccess),
    });
  };

  return (
    <ProviderSummary title={t("integrations.provider.gitlab")}>
      <Field label={t("integrations.gitlab.connection")} required>
        <Select
          options={reusable.map((c) => ({ value: c.id, label: connectionName(c) }))}
          value={connectionId}
          onChange={(v) => {
            setConnectionId(v);
            setPicked(null);
          }}
        />
      </Field>
      <GitLabRepositoryField projectId={projectId} connectionId={connectionId || undefined} value={picked?.pathWithNamespace ?? null} onPick={setPicked} />
      <AgentAccessChoice value={agentAccess} onChange={setAgentAccess} pathKind={gitlab.agentPathKind} canEdit={!bind.isPending} />
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={submit} loading={bind.isPending} disabled={!picked}>
          {t("integrations.gitlab.connectRepo")}
        </Button>
        <Button variant="ghost" size="sm" onClick={onNew}>
          {t("integrations.gitlab.newConnection")}
        </Button>
      </div>
    </ProviderSummary>
  );
}

/**
 * ISS-50 — the GitLab source host. A connection is a write-only access token and the instance's base
 * URL; the repository is each project's own pick from what that token can push to, stored on the
 * binding, so one connection serves every project it is bound to.
 */
export function GitlabSettings({ projectId }: { projectId: string }) {
  const b = useSingleBinding(projectId, gitlab, initialForm);
  const { existing, form, set, orgLocked } = b;
  const connections = useConnections();
  const [forceNew, setForceNew] = useState(false);
  const t = useCopy();

  const reusable = useMemo(
    () => (connections.data?.items ?? []).filter((c) => c.provider === gitlab.provider && c.active && c.hasSecrets),
    [connections.data],
  );
  const canSave = (existing !== undefined || form.token.trim().length >= 8) && !b.saving && !orgLocked;

  if (!existing && reusable.length > 0 && !forceNew) {
    return <UseExistingConnection projectId={projectId} reusable={reusable} onNew={() => setForceNew(true)} />;
  }

  async function handleSave() {
    b.test.reset();
    await b.save({ baseUrl: form.baseUrl.trim().replace(/\/+$/, "") || GITLAB_DEFAULT_BASE_URL }, ["token", form.token.trim()]);
    set("token", "");
  }

  return (
    <ProviderSummary title={t("integrations.provider.gitlab")} badge={activeBadge(existing, t)}>
      {existing && <BindingRepository projectId={projectId} binding={existing} />}
      <Field
        label={t("integrations.autoflow.token")}
        hint={existing ? t("integrations.provider.tokenStored") : t("integrations.gitlab.tokenHint")}
        required={!existing}
      >
        <Input
          type="password"
          autoComplete="off"
          placeholder={existing ? t("integrations.provider.unchanged") : (gitlab.secretPlaceholder ?? undefined)}
          value={form.token}
          onChange={(e) => set("token", e.target.value)}
          disabled={orgLocked}
        />
      </Field>
      {orgLocked && <OrgLockedNote />}
      {!existing && <ConnectionOwnerField projectId={projectId} value={b.ownerOrgId} onChange={b.setOwnerOrgId} />}
      <Field label={t("integrations.gitlab.baseUrl")}>
        <Input
          value={form.baseUrl}
          onChange={(e) => set("baseUrl", e.target.value)}
          placeholder={GITLAB_DEFAULT_BASE_URL}
          disabled={orgLocked}
        />
      </Field>
      {!existing && <p className="fg-body-sm text-muted">{t("integrations.gitlab.pickAfter")}</p>}
      <TestOutcome error={b.test.error} result={b.test.result} okText={t("integrations.gitlab.connectedTo", { host: gitlabHost(form.baseUrl) })} />
      {existing && gitlabRepositoryOf(existing.config) && <GitlabWebhook projectId={projectId} bindingId={existing.id} />}
      <SingleBindingFooter b={b} canSave={canSave} onSave={() => void handleSave()} />
    </ProviderSummary>
  );
}
