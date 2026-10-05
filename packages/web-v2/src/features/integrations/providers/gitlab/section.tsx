"use client";

import { Banner, Field, Input } from "@/design";
import { useState } from "react";
import { ConnectionOwnerField } from "../../components/connection-owner-field";
import type { IntegrationSummary } from "../../types";
import { activeBadge, OrgLockedNote, ProviderCard, TestOutcome } from "../shared";
import { SingleBindingFooter, useSingleBinding } from "../single-binding";
import { GITLAB_DEFAULT_BASE_URL, gitlab, gitlabHost } from "./index";
import { GitlabWebhookPanel } from "./webhook-panel";

/** `group/project` or deeper (`group/sub/project`): two or more segments GitLab would accept as a path. */
const GITLAB_PROJECT_PATH = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*(\/[A-Za-z0-9_.][A-Za-z0-9_.-]*)+$/;

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

/**
 * ISS-50 — the GitLab source host: one write-only access token, the instance's base URL, and the
 * project path the binding reads and writes.
 */
export function GitlabSection({ projectId }: { projectId: string }) {
  const b = useSingleBinding(projectId, gitlab, initialForm);
  const { existing, form, set, orgLocked } = b;
  const [pathError, setPathError] = useState<string | null>(null);
  const canSave =
    (existing !== undefined || form.token.trim().length >= 8) &&
    form.projectPath.trim().length > 0 &&
    !b.saving &&
    !orgLocked;

  async function handleSave() {
    b.test.reset();
    const config = {
      baseUrl: form.baseUrl.trim().replace(/\/+$/, "") || GITLAB_DEFAULT_BASE_URL,
      projectPath: form.projectPath.trim().replace(/^\/+|\/+$/g, ""),
    };
    if (!GITLAB_PROJECT_PATH.test(config.projectPath)) {
      setPathError(
        `"${config.projectPath}" is not a GitLab project path. Write it as it appears in the project's URL after the host, e.g. my-group/my-project.`,
      );
      return;
    }
    setPathError(null);
    const token = form.token.trim();
    await b.save(config, ["token", token]);
    set("token", "");
  }

  return (
    <ProviderCard title="GitLab" badge={activeBadge(existing)}>
      <p className="fg-body-sm text-muted">
        Connect one GitLab project as this project&apos;s source host. Forge reads its branches, merge
        requests and pipelines, and merges through it. Agents reach it through Forge only once the grant
        below is on.
      </p>
      <Field
        label="Access token"
        hint={
          existing
            ? "A token is stored. Leave blank to keep it; enter a new one to replace it."
            : "A project or group access token with the api scope. Stored encrypted; never shown again."
        }
        required={!existing}
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
      {orgLocked && <OrgLockedNote />}
      {!existing && <ConnectionOwnerField projectId={projectId} value={b.ownerOrgId} onChange={b.setOwnerOrgId} />}
      <Field label="Base URL" hint="Your GitLab instance. Leave as gitlab.com unless you self-host.">
        <Input
          value={form.baseUrl}
          onChange={(e) => set("baseUrl", e.target.value)}
          placeholder={GITLAB_DEFAULT_BASE_URL}
          disabled={orgLocked}
        />
      </Field>
      <Field label="Project path" hint="The part of the project's URL after the host, e.g. my-group/my-project." required>
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
      <TestOutcome error={b.test.error} result={b.test.result} okText={`Connected to ${gitlabHost(form.baseUrl)}.`} />
      {existing && <GitlabWebhookPanel projectId={projectId} bindingId={existing.id} />}
      <SingleBindingFooter b={b} canSave={canSave} onSave={handleSave} />
    </ProviderCard>
  );
}
