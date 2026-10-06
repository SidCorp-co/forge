"use client";

// GitHub connect surface. Unlike every other provider here, there is no
// credential to paste: GitHub mints the App, and Forge only ever sees what the
// manifest callback converts. So this section starts a redirect dance rather
// than submitting a form to our own API.

import { Badge, Button, PageSection, PageSectionBody, PageSectionHeader, PageSectionTitle } from "@/design";
import { useMemo, useState } from "react";
import { scopeLabel } from "../../components/status-pill";
import { useConnections, useIntegrationsList } from "../../hooks";
import type { IntegrationSummary } from "../../types";
import { CreateApp } from "./create-app";
import { BindingControls, repositoryOf, SetRepository, UseExistingApp } from "./repository";

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
    <PageSection>
      <PageSectionHeader>
        <PageSectionTitle>GitHub App</PageSectionTitle>
      </PageSectionHeader>
      <PageSectionBody className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Badge>{scopeLabel(binding.role)}</Badge>
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
      </PageSectionBody>
    </PageSection>
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
