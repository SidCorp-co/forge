"use client";

// GitHub connect surface. Unlike every other provider here, there is no
// credential to paste: GitHub mints the App, and Forge only ever sees what the
// manifest callback converts. So this section starts a redirect dance rather
// than submitting a form to our own API.

import { Badge, Banner, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, NativeSelect } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useMemo, useState } from "react";
import { useDeleteProviderIntegration, useGitHubConnect, useIntegrationsList } from "../hooks";
import type { GitHubConnectStart, IntegrationSummary } from "../types";
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
              no repository recorded yet — it is set when the App installation reports in
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
 * Create and install a GitHub App for one project. The button leaves this page:
 * GitHub renders the App-creation screen from the posted manifest, redirects to
 * the callback that stores the credential, then to the App's install page.
 */
export function GitHubSection({ projectId }: { projectId: string }) {
  const list = useIntegrationsList(projectId);
  const connect = useGitHubConnect(projectId);
  const [org, setOrg] = useState("");
  const [environment, setEnvironment] = useState("prod");

  const existing = useMemo(
    () => (list.data?.items ?? []).find((i) => i.provider === "github"),
    [list.data],
  );

  if (existing) return <ConnectedState projectId={projectId} binding={existing} />;

  const start = async () => {
    const res = await connect.mutateAsync({ org: org.trim() || undefined, environment });
    submitManifest(res);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect GitHub</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="fg-body-sm text-muted">
          Forge creates a GitHub App scoped to this project. You approve it on GitHub and choose
          which repositories it may see — no token is typed here, and Forge never asks for your
          password.
        </p>

        <Field label="Organization" hint="Leave blank to create the App on your personal account.">
          <Input
            value={org}
            onChange={(e) => setOrg(e.target.value)}
            placeholder="SidCorp-co"
            aria-label="Organization"
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
          <span className="fg-body-sm text-subtle">You will be sent to GitHub.</span>
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
