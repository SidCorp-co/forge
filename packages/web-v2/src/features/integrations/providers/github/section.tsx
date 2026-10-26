"use client";

// GitHub connect surface. Unlike every other provider here, there is no
// credential to paste: GitHub mints the App, and Forge only ever sees what the
// manifest callback converts. So this section starts a redirect dance rather
// than submitting a form to our own API.

import {
  Badge,
  Banner,
  Button,
  CardTitle,
  Field,
  Input,
  NativeSelect,
  Spinner,
  SettingsSection,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useProjects } from "@/features/projects/hooks";
import { mayCreateTheApp, refusalSaidByThePanel, takesTheApp } from "../../app-owner";
import { useMemo, useState } from "react";
import {
  useBindExistingConnection,
  useConnections,
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
import { text } from "../config-read";
import { github } from "./index";
import { bindableApps, unbindableReason } from "./reuse";
import {
  bindsRemovedConnection,
  IntegrationEnabledControl,
  onlyWho,
} from "../../components/integration-enabled-control";
import { DisconnectFromProject } from "../../components/disconnect-from-project";
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
  const repository = repositoryOf(binding.config);

  return (
    <>
      <IntegrationEnabledControl projectId={projectId} binding={binding} />

      <AgentAccessControl projectId={projectId} binding={binding} />

      {/* Disconnect took effect on one click (ISS-1421 r24); it asks once, in the words every
          provider's question uses (r27). */}
      <div className="flex flex-wrap items-center gap-2">
        <DisconnectFromProject
          projectId={projectId}
          binding={binding}
          subject={repository ? `GitHub (${repository.owner}/${repository.repo})` : "GitHub"}
        />
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
    <SettingsSection>
      <div className="mb-4 flex items-center justify-between gap-3">
        <CardTitle>GitHub App</CardTitle>
      </div>
      <div className="flex flex-col gap-3">
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
          {/* Offered to a reader core lets point the binding elsewhere (ISS-1421 r27). */}
          {binding.acts.change && (
            <Button variant="ghost" size="sm" onClick={onChangeRepository}>
              Change repository
            </Button>
          )}
        </div>

        <BindingControls projectId={projectId} binding={binding} />
      </div>
    </SettingsSection>
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
 * Not the bind route: a Disconnect leaves the binding's row behind, switched
 * off, and the bind route makes a second row beside it rather than taking that
 * one back with its installation. The PATCH merges binding-tier config onto the
 * surviving row instead, and sends
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
  // The repository list and the write are a project admin's (ISS-1421 r27): nobody else's drawer
  // reads a list core refuses them, or offers a Save it refuses.
  const mayPick = binding.acts.change;
  const repos = useGitHubRepositories(projectId, mayPick ? binding.connectionId : undefined);
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
    <SettingsSection>
      <div className="mb-4 flex items-center justify-between gap-3">
        <CardTitle>{current ? "Change repository" : "Connect a repository"}</CardTitle>
      </div>
      <div className="flex flex-col gap-4">
        <p className="fg-body-sm text-muted">
          Using <span className="font-semibold">{connectionLabel}</span>. This project already has a
          GitHub binding; picking here points that same binding at a repository.
        </p>

        {mayPick ? (
          <>
            <RepositoryField repos={repos} value={fullName} onChange={setFullName} />

            {!binding.bindingActive && (
              <p className="fg-body-sm text-muted">
                This binding is switched off. Saving a repository switches it back on.
              </p>
            )}

            {update.isError && <Banner tone="danger">{formatApiError(update.error)}</Banner>}

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={submit} disabled={!chosen || update.isPending}>
                {update.isPending ? "Saving…" : "Save repository"}
              </Button>
              {onDone && (
                <Button variant="ghost" size="sm" onClick={onDone}>
                  Cancel
                </Button>
              )}
            </div>
          </>
        ) : (
          <p className="fg-body-sm text-muted">
            {`${onlyWho(binding.acts.whoChanges)} can point this binding at a repository.`}
          </p>
        )}

        <BindingControls projectId={projectId} binding={binding} />
      </div>
    </SettingsSection>
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
    <SettingsSection>
      <div className="mb-4 flex items-center justify-between gap-3">
        <CardTitle>Connect a repository</CardTitle>
      </div>
      <div className="flex flex-col gap-4">
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

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={submit} disabled={!chosen || bind.isPending}>
            {bind.isPending ? "Connecting…" : "Connect repository"}
          </Button>
          <Button variant="ghost" size="sm" onClick={onNeedNewApp}>
            Create a separate App instead
          </Button>
        </div>
      </div>
    </SettingsSection>
  );
}

/**
 * A refused start re-reads the reader's projects, whose role decides what the panel offers: a role
 * lost in another tab otherwise left the button and the org admin's sentence up until a reload, inviting
 * the same refusal again (ISS-1421 r24). The refusal itself is the banner's, from the mutation's error.
 */
function refusedFor(projectsQ: { refetch: () => Promise<unknown> }): null {
  void projectsQ.refetch();
  return null;
}

/**
 * Who the App will belong to, stated rather than asked. This App is bound to
 * one project and used by its runners, so its owner follows that project's
 * org; a picker offering "Personal (only me)" would be a choice the server
 * does not honour, and personal ownership is what left a project's App
 * reachable by one person (ISS-1115). A project whose only org is a personal
 * one has no second principal, so it stays the operator's.
 */
function AppOwner({ projectId, act }: { projectId: string; act: "create" | "install" }) {
  const projectsQ = useProjects();
  const project = projectsQ.data?.find((p) => p.id === projectId);
  if (!project) return null;
  if (project.orgIsPersonal)
    return (
      <p className="fg-body-sm text-muted">
        The App will belong to you, and this project is the only one that uses it.
      </p>
    );
  return (
    <p className="fg-body-sm text-muted">
      {mayCreateTheApp(project)
        ? `The App will belong to ${project.orgName}, so every admin of this project can use and change it. Creating it needs org admin there.`
        : `The App will belong to ${project.orgName}. Only an owner or admin of ${project.orgName} can ${act} it, from this project's Integrations tab.`}
    </p>
  );
}

function CreateApp({
  projectId,
  onBack,
  unbindable,
}: {
  projectId: string;
  onBack: (() => void) | null;
  /** A reachable App this project cannot bind, and who can — said before offering a second one. */
  unbindable: string | null;
}) {
  const connect = useGitHubConnect(projectId);
  const [org, setOrg] = useState("");
  const projectsQ = useProjects();
  const project = projectsQ.data?.find((p) => p.id === projectId);
  // Owner ruling (ISS-1421 r23): no button this reader is known to be refused; AppOwner says who can.
  const offered = !project || mayCreateTheApp(project);

  const start = async () => {
    const res = await connect
      .mutateAsync({ org: org.trim() || undefined })
      .catch(() => refusedFor(projectsQ));
    if (res) submitManifest(res);
  };

  return (
    <SettingsSection>
      <div className="mb-4 flex items-center justify-between gap-3">
        <CardTitle>Create a GitHub App</CardTitle>
      </div>
      <div className="flex flex-col gap-4">
        {/* A reader who cannot create it is told who can, not how the act goes (ISS-1421 r24). */}
        {offered && (
          <p className="fg-body-sm text-muted">
            Forge creates one GitHub App for your organization, not one per project. You approve it
            on GitHub and choose which repositories it may see — no token is typed here.
          </p>
        )}

        {unbindable && <Banner tone="attention">{unbindable}</Banner>}

        <AppOwner projectId={projectId} act="create" />

        {offered && (
          <Field label="GitHub organization" hint="Leave blank to create the App on your personal account.">
            <Input
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              placeholder="SidCorp-co"
              aria-label="GitHub organization"
            />
          </Field>
        )}

        {connect.isError && !refusalSaidByThePanel(connect.error, project) && (
          <Banner tone="danger">{formatApiError(connect.error)}</Banner>
        )}

        <div className="flex flex-wrap items-center gap-3">
          {offered && (
            <Button onClick={start} disabled={connect.isPending}>
              {connect.isPending ? "Preparing…" : "Create GitHub App"}
            </Button>
          )}
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
      </div>
    </SettingsSection>
  );
}

/**
 * A project whose GitHub binding names a removed connection (ISS-1421 r22). The removed connection
 * holds no App, so there is no repository to list and no credential to enable; the one way back is
 * the install, which core's callback turns into that same connection. Disconnect keeps this project
 * off when another turns it back on; the row it leaves still holds the project's one GitHub binding,
 * so only a Clear of the connection frees it for a new App.
 */
function RemovedApp({
  projectId,
  binding,
  connection,
  connectionLabel,
}: {
  projectId: string;
  binding: IntegrationSummary;
  /** Absent where the reader's list does not hold it, and then whose the App would be is not said. */
  connection: { ownerType: "user" | "org"; ownerId: string } | undefined;
  connectionLabel: string;
}) {
  const connect = useGitHubConnect(projectId);
  const [org, setOrg] = useState("");
  const projectsQ = useProjects();
  const project = projectsQ.data?.find((p) => p.id === projectId);
  // Core refuses an install whose App would belong to someone else (ISS-1421 r23), so none is offered.
  const takes = connection && project ? takesTheApp(connection, project) : null;
  const offered = takes !== false && (!project || mayCreateTheApp(project));
  // A switched-off binding is not turned on by an install elsewhere (`reattach`), only by one from here.
  const left = !binding.bindingActive;
  // The exception is an install from here, which only a reader offered it can make (ISS-1421 r24).
  const staysOff =
    takes === false
      ? "so it stays off if the connection is turned back on"
      : offered
        ? "so it stays off if the connection is turned back on from anywhere but here"
        : "so it stays off if the connection is turned back on from another project";

  const start = async () => {
    // A refusal is the banner's to show from connect.error, never a rejection thrown past it.
    const res = await connect
      .mutateAsync({ org: org.trim() || undefined })
      .catch(() => refusedFor(projectsQ));
    if (res) submitManifest(res);
  };

  return (
    <SettingsSection>
      <div className="mb-4 flex items-center justify-between gap-3">
        <CardTitle>GitHub App</CardTitle>
      </div>
      <div className="flex flex-col gap-4">
        <p className="fg-body-sm text-muted">
          <span className="font-semibold">{connectionLabel}</span> was removed, so this project&apos;s
          GitHub has no App.
          {takes === true &&
            (offered
              ? " Installing the GitHub App again creates it on GitHub and turns that connection back on."
              : " Installing the GitHub App again would turn that connection back on.")}
          {takes === false &&
            " An App installed from this project would belong to someone other than that connection's owner, so it cannot turn it back on. The connection's owner can clear it from the list on the Integrations page, and then a new App can be created here."}
          {left && ` This project is disconnected from it, ${staysOff}.`}
        </p>

        {takes !== false && <AppOwner projectId={projectId} act="install" />}

        {offered && (
          <Field label="GitHub organization" hint="Leave blank to create the App on your personal account.">
            <Input
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              placeholder="SidCorp-co"
              aria-label="GitHub organization"
            />
          </Field>
        )}

        {/* AppOwner says who may only where it is drawn, which is where the App would be the owner's. */}
        {connect.isError && !(takes !== false && refusalSaidByThePanel(connect.error, project)) && (
          <Banner tone="danger">{formatApiError(connect.error)}</Banner>
        )}
        <div className="flex flex-wrap items-center gap-3">
          {offered && (
            <Button onClick={start} disabled={connect.isPending}>
              {connect.isPending ? "Preparing…" : "Install the GitHub App again"}
            </Button>
          )}
          <DisconnectFromProject
            projectId={projectId}
            binding={binding}
            subject={connectionLabel}
            staysOff={staysOff}
          />
        </div>
      </div>
    </SettingsSection>
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

  // The one switched on where a switched-off one stands beside it (ISS-1421 r32).
  const binding = useMemo(() => {
    const github = (list.data?.items ?? []).filter((i) => i.provider === "github");
    return github.find((i) => i.bindingActive) ?? github[0];
  }, [list.data]);

  // The App this project is offered is one the server would let it bind: managed by the caller
  // and, where an org owns it, owned by this project's own org. Offering any other would walk the
  // caller into a refusal on the last click (ISS-1216).
  const projectsQ = useProjects();
  const project = projectsQ.data?.find((p) => p.id === projectId);
  const target = useMemo(
    () => (project ? { orgId: project.orgId, orgName: project.orgName } : null),
    [project],
  );
  const reusable = useMemo(
    () => bindableApps(connections.data?.items ?? [], target),
    [connections.data, target],
  );
  const unbindable = useMemo(
    () =>
      unbindableReason(connections.data?.items ?? [], target, !project || mayCreateTheApp(project)),
    [connections.data, target, project],
  );

  // A row existing and a repository being recorded are two facts, and this used
  // to ask only the first. Nothing removes the row — Disconnect sets
  // `active: false` and `listBindingsForProject` filters on the project alone —
  // so the early return below fired for the life of the row and the picker was
  // unreachable (ISS-1115).
  const repository = binding ? repositoryOf(binding.config) : null;
  const boundConnection = binding
    ? (connections.data?.items ?? []).find((c) => c.id === binding.connectionId)
    : undefined;
  const connectionLabel = boundConnection?.displayName ?? "the existing GitHub App";

  // A removed connection holds no App: no picker, no Enable credential, one way back (ISS-1421 r22).
  if (binding && bindsRemovedConnection(binding)) {
    return (
      <RemovedApp
        projectId={projectId}
        binding={binding}
        connection={boundConnection}
        connectionLabel={connectionLabel}
      />
    );
  }

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
    <CreateApp
      projectId={projectId}
      onBack={first ? () => setForceCreate(false) : null}
      unbindable={unbindable}
    />
  );
}
