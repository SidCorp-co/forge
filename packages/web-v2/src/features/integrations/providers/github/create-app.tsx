"use client";

import { Banner, Button, Card, CardContent, CardHeader, CardTitle, Field, Input } from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";
import { useState } from "react";
import { useGitHubConnect } from "../../hooks";
import type { GitHubConnectStart } from "../../types";

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
 * Who the App will belong to, stated rather than asked. This App is bound to
 * one project and used by its runners, so its owner follows that project's
 * org; a picker offering "Personal (only me)" would be a choice the server
 * does not honour, and personal ownership is what left a project's App
 * reachable by one person (ISS-1115). A project whose only org is a personal
 * one has no second principal, so it stays the operator's.
 */
function AppOwner({ projectId }: { projectId: string }) {
  const projectsQ = useProjects();
  const project = projectsQ.data?.find((p) => p.id === projectId);
  if (!project) return null;
  return (
    <p className="fg-body-sm text-muted">
      {project.orgIsPersonal
        ? "The App will belong to you, and this project is the only one that uses it."
        : `The App will belong to ${project.orgName}, so every admin of this project can use and change it. Creating it needs org admin there.`}
    </p>
  );
}

export function CreateApp({ projectId, onBack }: { projectId: string; onBack: (() => void) | null }) {
  const connect = useGitHubConnect(projectId);
  const [org, setOrg] = useState("");

  const start = async () => {
    const res = await connect.mutateAsync({ org: org.trim() || undefined });
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

        <AppOwner projectId={projectId} />

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

