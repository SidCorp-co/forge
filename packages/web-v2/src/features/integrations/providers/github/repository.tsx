"use client";

import { Banner, Button, PageSection, PageSectionBody, PageSectionHeader, PageSectionTitle, Field, NativeSelect, Spinner } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useMemo, useState } from "react";
import { AGENT_ACCESS_CLOSED, AgentAccessChoice, AgentAccessControl, agentAccessBody } from "../../components/agent-access-control";
import { IntegrationEnabledControl } from "../../components/integration-enabled-control";
import {
  useBindConnection,
  useDeleteProviderIntegration,
  useGitHubRepositories,
  useUpdateProviderIntegration,
} from "../../hooks";
import type { AgentAccess, IntegrationSummary } from "../../types";
import { text } from "../config-read";
import { github } from "./index";

/**
 * The repository a binding records, or null. A binding ROW existing is a
 * different fact from a repository being recorded on it, and reading the first
 * as the second is what put the picker out of reach (ISS-1115).
 */
export function repositoryOf(config: Record<string, unknown>): { owner: string; repo: string } | null {
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
export function BindingControls({
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
          onClick={() => remove.mutate(binding)}
          disabled={remove.isPending}
        >
          Disconnect from this project
        </Button>
        {remove.isError && <Banner tone="danger">{formatApiError(remove.error)}</Banner>}
      </div>
    </>
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
export function SetRepository({
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
    <PageSection>
      <PageSectionHeader>
        <PageSectionTitle>{current ? "Change repository" : "Connect a repository"}</PageSectionTitle>
      </PageSectionHeader>
      <PageSectionBody className="flex flex-col gap-4">
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
      </PageSectionBody>
    </PageSection>
  );
}

/**
 * Bind a project to a repository the App can already see. The picker lists what
 * each installation actually granted, so a project can only point at a
 * repository the credential reaches. This is the no-binding-row path; a project
 * that already has a row goes through `SetRepository` above.
 */
export function UseExistingApp({
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
  const bind = useBindConnection(projectId);
  const [fullName, setFullName] = useState("");
  const [agentAccess, setAgentAccess] = useState<AgentAccess>(AGENT_ACCESS_CLOSED);

  const chosen = (repos.data?.repositories ?? []).find((r) => r.fullName === fullName);

  const submit = () => {
    if (!chosen) return;
    bind.mutate({
      connectionId,
      provider: github.provider,
      role: "service",
      binding: {
        owner: chosen.owner,
        repo: chosen.repo,
        installationId: chosen.installationId,
      },
      ...agentAccessBody(github.agentPathKind, agentAccess),
    });
  };

  return (
    <PageSection>
      <PageSectionHeader>
        <PageSectionTitle>Connect a repository</PageSectionTitle>
      </PageSectionHeader>
      <PageSectionBody className="flex flex-col gap-4">
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
      </PageSectionBody>
    </PageSection>
  );
}

