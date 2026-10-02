"use client";

import {
  Badge,
  Banner,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
} from "@/design";
import { useProject } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";
import { CORE_URL } from "@/lib/utils/core-url";
import { useMemo, useState } from "react";
import {
  useCreateProviderIntegration,
  useDeleteProviderIntegration,
  useIntegrationsList,
  useIsOrgAdmin,
  useOrgConnectionLocked,
  useRotateIntegrationSecret,
  useTestIntegration,
  useUpdateProviderIntegration,
} from "../../hooks";
import type { IntegrationSummary, IntegrationTestResult } from "../../types";
import {
  AGENT_ACCESS_CLOSED,
  AgentAccessChoice,
  AgentAccessControl,
  agentAccessBody,
  agentAccessDeniedReason,
  mayWriteAgentAccess,
} from "../../components/agent-access-control";
import type { AgentAccess } from "../../types";
import { ConnectionOwnerField } from "../../components/connection-owner-field";
import { IntegrationEnabledControl } from "../../components/integration-enabled-control";
import { GITLAB_DEFAULT_BASE_URL, gitlab, gitlabHost } from "./index";

/** `group/project` or deeper (`group/sub/project`): two or more segments GitLab would accept as a path. */
export const GITLAB_PROJECT_PATH = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*(\/[A-Za-z0-9_.][A-Za-z0-9_.-]*)+$/;

/** The events Forge reads off a GitLab webhook; any other ticked event is refused by core. */
export const GITLAB_WEBHOOK_EVENTS = ["Push events", "Merge request events", "Pipeline events"] as const;

interface FormState {
  token: string;
  baseUrl: string;
  projectPath: string;
}

function initialForm(existing: IntegrationSummary | undefined): FormState {
  const cfg = (existing?.config ?? {}) as { baseUrl?: unknown; projectPath?: unknown };
  return {
    token: "",
    baseUrl: typeof cfg.baseUrl === "string" && cfg.baseUrl ? cfg.baseUrl : GITLAB_DEFAULT_BASE_URL,
    projectPath: typeof cfg.projectPath === "string" ? cfg.projectPath : "",
  };
}

function toConfig(f: FormState): { baseUrl: string; projectPath: string } {
  return {
    baseUrl: f.baseUrl.trim().replace(/\/+$/, "") || GITLAB_DEFAULT_BASE_URL,
    projectPath: f.projectPath.trim().replace(/^\/+|\/+$/g, ""),
  };
}

/** Where GitLab posts deliveries for this project: core's inbound door, under the project's slug. */
function webhookUrl(slug: string | undefined): string {
  const origin = CORE_URL || (typeof window !== "undefined" ? window.location.origin : "");
  return `${origin}/api/webhooks/in/${slug ?? "<project slug>"}`;
}

/**
 * ISS-50 — the GitLab source host. One access token (write-only, never returned), the instance's
 * base URL, and the project path the binding reads and writes. Once bound, the section says how to
 * point the GitLab project's webhook at Forge: the URL, the secret token, and the three events.
 */
export function GitlabSection({ projectId }: { projectId: string }) {
  const list = useIntegrationsList(projectId);
  const existing = useMemo(
    () => list.data?.items.find((i) => i.provider === "gitlab"),
    [list.data],
  );
  const project = useProject(projectId);

  const create = useCreateProviderIntegration(projectId);
  const [ownerOrgId, setOwnerOrgId] = useState<string | undefined>(undefined);
  const update = useUpdateProviderIntegration(projectId);
  const test = useTestIntegration(projectId);
  const remove = useDeleteProviderIntegration(projectId);
  const rotate = useRotateIntegrationSecret(projectId);

  const [form, setForm] = useState<FormState>(() => initialForm(existing));
  const [seededFor, setSeededFor] = useState<string | null>(existing?.id ?? null);
  if ((existing?.id ?? null) !== seededFor) {
    setForm(initialForm(existing));
    setSeededFor(existing?.id ?? null);
  }

  const [testResult, setTestResult] = useState<IntegrationTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [pathError, setPathError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [secretError, setSecretError] = useState<string | null>(null);
  const [agentAccess, setAgentAccess] = useState<AgentAccess>(AGENT_ACCESS_CLOSED);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const tokenRequired = !existing;
  const orgLocked = useOrgConnectionLocked(projectId, existing?.connectionId);
  const isOrgAdmin = useIsOrgAdmin(projectId);
  const canSave =
    (!tokenRequired || form.token.trim().length >= 8) &&
    form.projectPath.trim().length > 0 &&
    !create.isPending &&
    !update.isPending &&
    !orgLocked;

  async function handleSave() {
    setTestResult(null);
    setTestError(null);
    const config = toConfig(form);
    if (!GITLAB_PROJECT_PATH.test(config.projectPath)) {
      setPathError(
        `"${config.projectPath}" is not a GitLab project path. Write it as it appears in the project's URL after the host, e.g. my-group/my-project.`,
      );
      return;
    }
    setPathError(null);
    const token = form.token.trim();
    if (existing) {
      await update.mutateAsync({
        id: existing.id,
        body: { config, ...(token ? { secrets: { token } } : {}) },
      });
    } else {
      await create.mutateAsync({
        provider: "gitlab",
        role: "service",
        config,
        secrets: { token },
        ...agentAccessBody(gitlab.agentPathKind, agentAccess),
        ...(ownerOrgId ? { orgId: ownerOrgId } : {}),
      });
    }
    setForm((f) => ({ ...f, token: "" }));
  }

  async function handleTest() {
    if (!existing) return;
    setTestResult(null);
    setTestError(null);
    try {
      setTestResult(await test.mutateAsync(existing.id));
    } catch (err) {
      setTestError(formatApiError(err));
    }
  }

  async function handleGenerateSecret() {
    if (!existing) return;
    setSecretError(null);
    try {
      const res = await rotate.mutateAsync(existing.id);
      setSecret(res.integrationSecret);
    } catch (err) {
      setSecretError(formatApiError(err));
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>GitLab</CardTitle>
          {existing && (
            <Badge tone={existing.active ? "green" : "neutral"}>
              {existing.active ? "Active" : "Disabled"}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          <p className="fg-body-sm text-muted">
            Connect one GitLab project as this project&apos;s source host. Forge reads its branches,
            merge requests and pipelines, and merges through it. Agents reach it through Forge only
            once the grant below is on.
          </p>

          <Field
            label="Access token"
            hint={
              existing
                ? "A token is stored. Leave blank to keep it; enter a new one to replace it."
                : "A project or group access token with the api scope. Stored encrypted; never shown again."
            }
            required={tokenRequired}
          >
            <Input
              type="password"
              autoComplete="off"
              placeholder={existing ? "•••••••• (unchanged)" : (gitlab.secretPlaceholder ?? undefined)}
              value={form.token}
              onChange={(e) => set("token", e.target.value)}
              disabled={orgLocked}
            />
          </Field>

          {orgLocked && (
            <p className="fg-body-sm text-muted">
              Org-shared credential — only an org owner/admin can change it.
            </p>
          )}

          {!existing && (
            <ConnectionOwnerField projectId={projectId} value={ownerOrgId} onChange={setOwnerOrgId} />
          )}

          <Field label="Base URL" hint="Your GitLab instance. Leave as gitlab.com unless you self-host.">
            <Input
              value={form.baseUrl}
              onChange={(e) => set("baseUrl", e.target.value)}
              placeholder={GITLAB_DEFAULT_BASE_URL}
              disabled={orgLocked}
            />
          </Field>

          <Field
            label="Project path"
            hint="The part of the project's URL after the host, e.g. my-group/my-project."
            required
          >
            <Input
              value={form.projectPath}
              onChange={(e) => {
                set("projectPath", e.target.value);
                setPathError(null);
              }}
              placeholder="my-group/my-project"
            />
          </Field>
          {pathError && <Banner tone="danger">{pathError}</Banner>}

          {testError && <Banner tone="danger">{testError}</Banner>}
          {testResult &&
            (testResult.status === "ok" ? (
              <Banner tone="success">Connected to {gitlabHost(form.baseUrl)}.</Banner>
            ) : (
              <Banner tone="danger">{testResult.message ?? "Connection failed"}</Banner>
            ))}

          {existing && (
            <div className="flex flex-col gap-2 rounded-md border border-border p-3" data-testid="gitlab-webhook">
              <span className="fg-label">Webhook</span>
              <p className="fg-body-sm text-muted">
                In the GitLab project, open Settings → Webhooks and add a webhook with:
              </p>
              <dl className="fg-body-sm grid grid-cols-1 gap-1 sm:grid-cols-[max-content_1fr] sm:gap-x-3">
                <dt className="text-muted">URL</dt>
                <dd className="min-w-0 break-all font-mono">{webhookUrl(project.data?.slug)}</dd>
                <dt className="text-muted">Secret token</dt>
                <dd className="min-w-0">
                  {secret ? (
                    <span className="break-all font-mono">{secret}</span>
                  ) : (
                    <span className="text-muted">
                      Forge cannot show a token it already holds. Generate one below and paste it
                      into GitLab.
                    </span>
                  )}
                </dd>
                <dt className="text-muted">Trigger</dt>
                <dd>{GITLAB_WEBHOOK_EVENTS.join(", ")} — and nothing else; Forge refuses other events.</dd>
              </dl>
              {secret && (
                <Banner tone="attention">
                  Copy this token now. It is shown once, and it has replaced any earlier one.
                </Banner>
              )}
              {secretError && <Banner tone="danger">{secretError}</Banner>}
              <div>
                <Button variant="secondary" onClick={handleGenerateSecret} loading={rotate.isPending}>
                  Generate secret token
                </Button>
              </div>
              <p className="fg-body-sm text-muted">
                Generating a token replaces the previous one; deliveries carrying the old token are
                turned away until GitLab has the new one.
              </p>
            </div>
          )}

          {existing ? (
            <AgentAccessControl
              projectId={projectId}
              binding={existing}
              canEdit={true}
              disabledReason={agentAccessDeniedReason(gitlab.agentPathKind)}
            />
          ) : (
            <AgentAccessChoice
              value={agentAccess}
              onChange={setAgentAccess}
              pathKind={gitlab.agentPathKind}
              canEdit={mayWriteAgentAccess(gitlab.agentPathKind, { canEditProject: true, isOrgAdmin })}
              disabledReason={agentAccessDeniedReason(gitlab.agentPathKind)}
            />
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="flex items-center gap-3">
              <Button
                variant="primary"
                onClick={handleSave}
                loading={create.isPending || update.isPending}
                disabled={!canSave}
              >
                {existing ? "Save" : "Create integration"}
              </Button>
              {existing && (
                <Button variant="secondary" onClick={handleTest} loading={test.isPending}>
                  Test connection
                </Button>
              )}
            </div>
            {existing && (
              <div className="flex items-center gap-4">
                <IntegrationEnabledControl projectId={projectId} binding={existing} />
                <Button
                  variant="danger"
                  icon="trash"
                  loading={remove.isPending}
                  onClick={() => remove.mutate(existing)}
                >
                  Remove
                </Button>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
