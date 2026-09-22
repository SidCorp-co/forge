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
  useUpdateProviderIntegration,
} from "../../hooks";
import type { GitHubConnectStart, IntegrationSummary } from "../../types";
import {
  AGENT_ACCESS_CLOSED,
  AgentAccessChoice,
  AgentAccessControl, agentAccessBody} from "../../components/agent-access-control";
import type { AgentAccess } from "../../types";
import { ConnectionOwnerField } from "../../components/connection-owner-field";
import { text } from "../config-read";
import { github } from "./index";
import { IntegrationEnabledControl } from "../../components/integration-enabled-control";
import { scopeLabel } from "../../components/status-pill";

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

/**
 * The repository a binding records, or null. A binding ROW existing is a
 * different fact from a repository being recorded on it, and reading the first
 * as the second is what put the picker out of reach (ISS-1115).
 */
function repositoryOf(config: Record<string, unknown>): { owner: string; repo: string } | null {
  const owner = text(config, "owner");
  const repo = text(config, "repo");
  return owner && repo ? { owner, repo } : null;
}

/**
 * Enable, agent access and Disconnect. Every card built over a binding row
 * carries these, so the picker is never the only thing on the screen: an App
 * whose repository list comes back empty or failing would otherwise leave an
 * admin with no control at all on the binding they already have.
 */
function BindingControls({
  projectId,
  binding,
}: {
  projectId: string;
  binding: IntegrationSummary;
}) {
  const remove = useDeleteProviderIntegration(projectId);

  return (
    <>
      <IntegrationEnabledControl projectId={projectId} binding={binding} />

      <AgentAccessControl projectId={projectId} binding={binding} canEdit />

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
    </>
  );
}

function ConnectedState({
  projectId,
  binding,
  repository,
  onChangeRepository,
}: {
  projectId: string;
  binding: IntegrationSummary;
  repository: { owner: string; repo: string };
  onChangeRepository: () => void;
}) {
  const { owner, repo } = repository;

  return (
    <Card>
      <CardHeader>
        <CardTitle>GitHub App</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Badge>{scopeLabel(binding.role, binding.stages)}</Badge>
          <a
            href={`https://github.com/${owner}/${repo}`}
            target="_blank"
            rel="noreferrer"
            className="text-13 font-semibold text-accent hover:underline"
          >
            {owner}/{repo}
          </a>
          <Button variant="ghost" size="sm" onClick={onChangeRepository}>
            Change repository
          </Button>
        </div>

        <BindingControls projectId={projectId} binding={binding} />
      </CardContent>
    </Card>
  );
}

/**
 * The list of repositories the App actually granted, with its own loading,
 * failure and empty states. One field, two submit paths: a project with no
 * binding row creates one, a project with a row writes onto it.
 */
function RepositoryField({
  repos,
  value,
  onChange,
}: {
  repos: ReturnType<typeof useGitHubRepositories>;
  value: string;
  onChange: (fullName: string) => void;
}) {
  const options = useMemo(
    () => (repos.data?.repositories ?? []).map((r) => ({ value: r.fullName, label: r.fullName })),
    [repos.data],
  );

  if (repos.isLoading) return <Spinner />;
  if (repos.isError) return <Banner tone="danger">{formatApiError(repos.error)}</Banner>;
  if (options.length === 0) {
    return (
      <Banner tone="attention">
        This App has no repositories yet. Grant it some on GitHub, then reload.
      </Banner>
    );
  }

  return (
    <>
      <Field label="Repository">
        <NativeSelect
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Repository"
          options={[{ value: "", label: "Choose a repository…" }, ...options]}
        />
      </Field>
      {repos.data?.truncated && (
        <p className="fg-body-sm text-subtle">
          Showing the first pages of a large installation — not every repository is listed.
        </p>
      )}
    </>
  );
}

/**
 * Write a repository onto a binding this project ALREADY holds.
 *
 * Not the bind route: `integration_bindings_service_uq` is on
 * (project, provider, label) with no `active` predicate, so a row left behind by
 * a Disconnect still holds the slot and a create against it is refused 409. The
 * PATCH merges binding-tier config onto the surviving row instead, and sends
 * `active` only when the row is switched off, so a write that changes nothing
 * about whether the binding resolves does not say it does.
 */
function SetRepository({
  projectId,
  binding,
  connectionLabel,
  onDone,
}: {
  projectId: string;
  binding: IntegrationSummary;
  connectionLabel: string;
  onDone: (() => void) | null;
}) {
  const repos = useGitHubRepositories(projectId, binding.connectionId);
  const update = useUpdateProviderIntegration(projectId);
  const current = repositoryOf(binding.config);
  const [fullName, setFullName] = useState(current ? `${current.owner}/${current.repo}` : "");

  const chosen = (repos.data?.repositories ?? []).find((r) => r.fullName === fullName);

  const submit = () => {
    if (!chosen) return;
    update.mutate(
      {
        id: binding.id,
        body: {
          config: {
            owner: chosen.owner,
            repo: chosen.repo,
            installationId: chosen.installationId,
          },
          ...(binding.bindingActive ? {} : { active: true }),
        },
      },
      { onSuccess: () => onDone?.() },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{current ? "Change repository" : "Connect a repository"}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="fg-body-sm text-muted">
          Using <span className="font-semibold">{connectionLabel}</span>. This project already has a
          GitHub binding; picking here points that same binding at a repository.
        </p>

        <RepositoryField repos={repos} value={fullName} onChange={setFullName} />

        {!binding.bindingActive && (
          <p className="fg-body-sm text-muted">
            This binding is switched off. Saving a repository switches it back on.
          </p>
        )}

        {update.isError && <Banner tone="danger">{formatApiError(update.error)}</Banner>}

        <div className="flex items-center gap-3">
          <Button onClick={submit} disabled={!chosen || update.isPending}>
            {update.isPending ? "Saving…" : "Save repository"}
          </Button>
          {onDone && (
            <Button variant="ghost" size="sm" onClick={onDone}>
              Cancel
            </Button>
          )}
        </div>

        <BindingControls projectId={projectId} binding={binding} />
      </CardContent>
    </Card>
  );
}

/**
 * Bind a project to a repository the App can already see. The picker lists what
 * each installation actually granted, so a project can only point at a
 * repository the credential reaches. This is the no-binding-row path; a project
 * that already has a row goes through `SetRepository` above.
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
  const [agentAccess, setAgentAccess] = useState<AgentAccess>(AGENT_ACCESS_CLOSED);

  const chosen = (repos.data?.repositories ?? []).find((r) => r.fullName === fullName);

  const submit = () => {
    if (!chosen) return;
    bind.mutate({
      id: connectionId,
      body: {
        projectId,
        // github is never a deploy target — `providerCanDeploy('github')` is
        // false, so a repo host can only be a project-wide service.
        role: "service",
        config: {
          owner: chosen.owner,
          repo: chosen.repo,
          installationId: chosen.installationId,
        },
        ...agentAccessBody(github.agentPathKind, agentAccess),
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

        <RepositoryField repos={repos} value={fullName} onChange={setFullName} />

        <AgentAccessChoice
          value={agentAccess}
          onChange={setAgentAccess}
          pathKind={github.agentPathKind}
          canEdit={true}
        />

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
  const [orgId, setOrgId] = useState<string | undefined>(undefined);

  const start = async () => {
    const res = await connect.mutateAsync({ org: org.trim() || undefined, orgId });
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
  const [changing, setChanging] = useState(false);

  const binding = useMemo(
    () => (list.data?.items ?? []).find((i) => i.provider === "github"),
    [list.data],
  );

  const reusable = useMemo(
    () => (connections.data?.items ?? []).filter((c) => c.provider === "github" && c.active),
    [connections.data],
  );

  // A row existing and a repository being recorded are two facts, and this used
  // to ask only the first. Nothing removes the row — Disconnect sets
  // `active: false` and `listBindingsForProject` filters on the project alone —
  // so the early return below fired for the life of the row and the picker was
  // unreachable (ISS-1115).
  const repository = binding ? repositoryOf(binding.config) : null;
  const connectionLabel =
    (binding
      ? (connections.data?.items ?? []).find((c) => c.id === binding.connectionId)?.displayName
      : null) ?? "the existing GitHub App";

  if (binding && repository && !changing) {
    return (
      <ConnectedState
        projectId={projectId}
        binding={binding}
        repository={repository}
        onChangeRepository={() => setChanging(true)}
      />
    );
  }

  if (binding) {
    return (
      <SetRepository
        projectId={projectId}
        binding={binding}
        connectionLabel={connectionLabel}
        onDone={repository ? () => setChanging(false) : null}
      />
    );
  }

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
