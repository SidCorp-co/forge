"use client";

// GitHub connect surface. Unlike every other provider here, there is no
// credential to paste: GitHub mints the App, and Forge only ever sees what the
// manifest callback converts. So this section starts a redirect dance rather
// than submitting a form to our own API.

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
  NativeSelect,
  Spinner,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useMemo, useState } from "react";
import {
  useBindExistingConnection,
  useConnections,
  useDeleteProviderIntegration,
  useGitHubConnect,
  useGitHubRepositories,
  useIntegrationsList,
} from "../hooks";
import type { GitHubConnectStart, IntegrationSummary } from "../types";
import { ConnectionOwnerField } from "./connection-owner-field";
import { IntegrationEnabledControl } from "./integration-enabled-control";

// cm:guard POST this as a real FORM navigation, never `fetch` — GitHub's App-manifest flow reads `manifest` from a top-level form POST, and the redirect back to /api/integrations/github/manifest-callback authenticates on the `forge_auth` cookie (SameSite=Lax), which a background request would not carry
function submitManifest(start: GitHubConnectStart): void {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = `${start.postUrl}?state=${encodeURIComponent(start.state)}`;
  const field = document.createElement("input");
  field.type = "hidden";
  field.name = "manifest";
  field.value = JSON.stringify(start.manifest);
  form.appendChild(field);
  document.body.appendChild(form);
  form.submit();
}

function permissionRows(manifest: Record<string, unknown>): [string, string][] {
  const perms = manifest.default_permissions;
  if (!perms || typeof perms !== "object") return [];
  return Object.entries(perms as Record<string, unknown>).map(([k, v]) => [k, String(v)]);
}

function ConnectedState({
  projectId,
  binding,
}: {
  projectId: string;
  binding: IntegrationSummary;
}) {
  const remove = useDeleteProviderIntegration(projectId);
  const owner = typeof binding.config.owner === "string" ? binding.config.owner : null;
  const repo = typeof binding.config.repo === "string" ? binding.config.repo : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>GitHub App</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Badge>{binding.environment}</Badge>
          {owner && repo ? (
            <a
              href={`https://github.com/${owner}/${repo}`}
              target="_blank"
              rel="noreferrer"
              className="text-[13px] font-semibold text-accent hover:underline"
            >
              {owner}/{repo}
            </a>
          ) : (
            <span className="fg-body-sm text-muted">
              no repository recorded yet — pick one by reconnecting this project
            </span>
          )}
        </div>

        <IntegrationEnabledControl projectId={projectId} binding={binding} />

        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => remove.mutate(binding.id)}
            disabled={remove.isPending}
          >
            Disconnect from this project
          </Button>
          {remove.isError && <Banner tone="danger">{formatApiError(remove.error)}</Banner>}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Bind a project to a repository the App can already see. The picker lists what
 * each installation actually granted, so a project can only point at a
 * repository the credential reaches.
 */
function UseExistingApp({
  projectId,
  connectionId,
  connectionLabel,
  onNeedNewApp,
}: {
  projectId: string;
  connectionId: string;
  connectionLabel: string;
  onNeedNewApp: () => void;
}) {
  const repos = useGitHubRepositories(projectId, connectionId);
  const bind = useBindExistingConnection();
  const [fullName, setFullName] = useState("");
  const [environment, setEnvironment] = useState("prod");

  const options = useMemo(
    () => (repos.data?.repositories ?? []).map((r) => ({ value: r.fullName, label: r.fullName })),
    [repos.data],
  );

  const chosen = (repos.data?.repositories ?? []).find((r) => r.fullName === fullName);

  const submit = () => {
    if (!chosen) return;
    bind.mutate({
      id: connectionId,
      body: {
        projectId,
        environment: environment === "staging" ? "staging" : "prod",
        config: {
          owner: chosen.owner,
          repo: chosen.repo,
          installationId: chosen.installationId,

        },
      },
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect a repository</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="fg-body-sm text-muted">
          Using <span className="font-semibold">{connectionLabel}</span>. One App serves every
          project; this project just points at one of its repositories.
        </p>

        {repos.isLoading ? (
          <Spinner />
        ) : repos.isError ? (
          <Banner tone="danger">{formatApiError(repos.error)}</Banner>
        ) : options.length === 0 ? (
          <Banner tone="attention">
            This App has no repositories yet. Grant it some on GitHub, then reload.
          </Banner>
        ) : (
          <Field label="Repository">
            <NativeSelect
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              aria-label="Repository"
              options={[{ value: "", label: "Choose a repository…" }, ...options]}
            />
          </Field>
        )}

        {repos.data?.truncated && (
          <p className="fg-body-sm text-subtle">
            Showing the first pages of a large installation — not every repository is listed.
          </p>
        )}

        <Field label="Environment">
          <NativeSelect
            value={environment}
            onChange={(e) => setEnvironment(e.target.value)}
            aria-label="Environment"
            options={[
              { value: "prod", label: "Production" },
              { value: "staging", label: "Staging" },
            ]}
          />
        </Field>

        {bind.isError && <Banner tone="danger">{formatApiError(bind.error)}</Banner>}

        <div className="flex items-center gap-3">
          <Button onClick={submit} disabled={!chosen || bind.isPending}>
            {bind.isPending ? "Connecting…" : "Connect repository"}
          </Button>
          <Button variant="ghost" size="sm" onClick={onNeedNewApp}>
            Create a separate App instead
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function CreateApp({ projectId, onBack }: { projectId: string; onBack: (() => void) | null }) {
  const connect = useGitHubConnect(projectId);
  const [org, setOrg] = useState("");
  const [environment, setEnvironment] = useState("prod");
  const [orgId, setOrgId] = useState<string | undefined>(undefined);

  const start = async () => {
    const res = await connect.mutateAsync({
      org: org.trim() || undefined,
      environment,
      orgId,
    });
    submitManifest(res);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create a GitHub App</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="fg-body-sm text-muted">
          Forge creates one GitHub App for your organization, not one per project. You approve it on
          GitHub and choose which repositories it may see — no token is typed here.
        </p>

        <ConnectionOwnerField projectId={projectId} value={orgId} onChange={setOrgId} />

        <Field label="GitHub organization" hint="Leave blank to create the App on your personal account.">
          <Input
            value={org}
            onChange={(e) => setOrg(e.target.value)}
            placeholder="SidCorp-co"
            aria-label="GitHub organization"
          />
        </Field>

        <Field label="Environment">
          <NativeSelect
            value={environment}
            onChange={(e) => setEnvironment(e.target.value)}
            aria-label="Environment"
            options={[
              { value: "prod", label: "Production" },
              { value: "staging", label: "Staging" },
            ]}
          />
        </Field>

        {connect.isError && <Banner tone="danger">{formatApiError(connect.error)}</Banner>}

        <div className="flex items-center gap-3">
          <Button onClick={start} disabled={connect.isPending}>
            {connect.isPending ? "Preparing…" : "Create GitHub App"}
          </Button>
          {onBack && (
            <Button variant="ghost" size="sm" onClick={onBack}>
              Use an existing App
            </Button>
          )}
        </div>

        {connect.data && (
          <div className="flex flex-col gap-1">
            <span className="fg-body-sm font-semibold">Permissions requested</span>
            {permissionRows(connect.data.manifest).map(([name, level]) => (
              <span key={name} className="fg-body-sm text-muted">
                {name}: <span className="font-mono">{level}</span>
              </span>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * One App per organization, one binding per project. An existing App is offered
 * first; creating another is the deliberate path, not the default.
 */
export function GitHubSection({ projectId }: { projectId: string }) {
  const list = useIntegrationsList(projectId);
  const connections = useConnections();
  const [forceCreate, setForceCreate] = useState(false);

  const existing = useMemo(
    () => (list.data?.items ?? []).find((i) => i.provider === "github"),
    [list.data],
  );

  const reusable = useMemo(
    () => (connections.data?.items ?? []).filter((c) => c.provider === "github" && c.active),
    [connections.data],
  );

  if (existing) return <ConnectedState projectId={projectId} binding={existing} />;

  const first = reusable[0];
  if (first && !forceCreate) {
    return (
      <UseExistingApp
        projectId={projectId}
        connectionId={first.id}
        connectionLabel={first.displayName ?? "the existing GitHub App"}
        onNeedNewApp={() => setForceCreate(true)}
      />
    );
  }

  return (
    <CreateApp projectId={projectId} onBack={first ? () => setForceCreate(false) : null} />
  );
}
