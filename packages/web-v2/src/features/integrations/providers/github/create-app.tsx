
import { Banner, Button, PageSection, PageSectionBody, PageSectionHeader, PageSectionTitle } from "@/design";
import { useProjects } from "@/features/projects";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { useGitHubConnect } from "../../hooks";
import type { GitHubConnectStart } from "../../types";

function submitManifest(start: Extract<GitHubConnectStart, { kind: "manifest" }>): void {
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
 * Connect GitHub for `projectId`'s org: the instance App's install page, or, where this Forge has no
 * App yet and the caller is its operator, the manifest that makes it. Begun from the workspace
 * Integrations page (`returnTo`), the install step lands back there, where the App is bound into
 * its projects.
 */
export function CreateApp({
  projectId,
  onBack,
  returnTo,
}: {
  projectId: string;
  onBack: (() => void) | null;
  returnTo?: "integrations";
}) {
  const connect = useGitHubConnect(projectId);
  const t = useCopy();

  const start = async () => {
    const res = await connect.mutateAsync(returnTo ? { returnTo } : {});
    if (res.kind === "install") window.location.assign(res.installUrl);
    else submitManifest(res);
  };

  return (
    <PageSection>
      <PageSectionHeader>
        <PageSectionTitle>{t("integrations.github.createTitle")}</PageSectionTitle>
      </PageSectionHeader>
      <PageSectionBody className="flex flex-col gap-4">
        <p className="fg-body-sm text-muted">{t("integrations.github.ownerInstance")}</p>

        {connect.isError && <Banner tone="danger">{formatApiError(connect.error)}</Banner>}

        <div className="flex items-center gap-3">
          <Button onClick={() => void start()} disabled={connect.isPending}>
            {connect.isPending ? t("integrations.github.preparing") : t("integrations.github.create")}
          </Button>
          {onBack && (
            <Button variant="ghost" size="sm" onClick={onBack}>
              {t("integrations.github.useExisting")}
            </Button>
          )}
        </div>

        {connect.data?.kind === "manifest" && (
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


/**
 * GitHub's step on the workspace Integrations page (FB-128): the install is recorded for the first
 * ticked project's org, and lands back there, where each project picks its repository.
 */
export function WorkspaceCreateApp({ projectId }: { projectId: string }) {
  const project = useProjects().data?.find((p) => p.id === projectId);
  const t = useCopy();
  return (
    <div className="flex flex-col gap-3">
      {project && <p className="fg-body-sm text-muted">{t("integrations.addFlow.githubNamed", { project: project.name })}</p>}
      <CreateApp projectId={projectId} onBack={null} returnTo="integrations" />
    </div>
  );
}
