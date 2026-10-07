"use client";

import { Banner, Button, PageSection, PageSectionBody, PageSectionHeader, PageSectionTitle, Field, Input } from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
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
  const t = useCopy();
  if (!project) return null;
  return (
    <p className="fg-body-sm text-muted">
      {project.orgIsPersonal
        ? t("integrations.github.ownerYou")
        : t("integrations.github.ownerOrg", { org: project.orgName })}
    </p>
  );
}

export function CreateApp({ projectId, onBack }: { projectId: string; onBack: (() => void) | null }) {
  const connect = useGitHubConnect(projectId);
  const [org, setOrg] = useState("");
  const t = useCopy();

  const start = async () => {
    const res = await connect.mutateAsync({ org: org.trim() || undefined });
    submitManifest(res);
  };

  return (
    <PageSection>
      <PageSectionHeader>
        <PageSectionTitle>{t("integrations.github.createTitle")}</PageSectionTitle>
      </PageSectionHeader>
      <PageSectionBody className="flex flex-col gap-4">
        <p className="fg-body-sm text-muted">
          {t("integrations.github.createIntro")}
        </p>

        <AppOwner projectId={projectId} />

        <Field label={t("integrations.github.org")} hint={t("integrations.github.orgHint")}>
          <Input
            value={org}
            onChange={(e) => setOrg(e.target.value)}
            placeholder="SidCorp-co"
            aria-label={t("integrations.github.org")}
          />
        </Field>

        {connect.isError && <Banner tone="danger">{formatApiError(connect.error)}</Banner>}

        <div className="flex items-center gap-3">
          <Button onClick={start} disabled={connect.isPending}>
            {connect.isPending ? t("integrations.github.preparing") : t("integrations.github.create")}
          </Button>
          {onBack && (
            <Button variant="ghost" size="sm" onClick={onBack}>
              {t("integrations.github.useExisting")}
            </Button>
          )}
        </div>

        {connect.data && (
          <div className="flex flex-col gap-1">
            <span className="fg-body-sm font-semibold">{t("integrations.github.permissions")}</span>
            {permissionRows(connect.data.manifest).map(([name, level]) => (
              <span key={name} className="fg-body-sm text-muted">
                {name}: <span className="font-mono">{level}</span>
              </span>
            ))}
          </div>
        )}
      </PageSectionBody>
    </PageSection>
  );
}

