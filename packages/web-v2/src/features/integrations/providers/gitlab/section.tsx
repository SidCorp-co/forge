"use client";

import { Banner, Field, Input } from "@/design";
import { useState } from "react";
import { useCopy } from "@/lib/i18n/interface-language";
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
  const t = useCopy();
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
      setPathError(t("integrations.gitlab.badPath", { path: config.projectPath }));
      return;
    }
    setPathError(null);
    const token = form.token.trim();
    await b.save(config, ["token", token]);
    set("token", "");
  }

  return (
    <ProviderCard title="GitLab" badge={activeBadge(existing, t)}>
      <p className="fg-body-sm text-muted">{t("integrations.gitlab.intro")}</p>
      <Field
        label={t("integrations.autoflow.token")}
        hint={existing ? t("integrations.provider.tokenStored") : t("integrations.gitlab.tokenHint")}
        required={!existing}
      >
        <Input
          type="password"
          autoComplete="off"
          placeholder={existing ? t("integrations.provider.unchanged") : (gitlab.secretPlaceholder ?? undefined)}
          value={form.token}
          onChange={(e) => set("token", e.target.value)}
          disabled={orgLocked}
        />
      </Field>
      {orgLocked && <OrgLockedNote />}
      {!existing && <ConnectionOwnerField projectId={projectId} value={b.ownerOrgId} onChange={b.setOwnerOrgId} />}
      <Field label={t("integrations.gitlab.baseUrl")} hint={t("integrations.gitlab.baseUrlHint")}>
        <Input
          value={form.baseUrl}
          onChange={(e) => set("baseUrl", e.target.value)}
          placeholder={GITLAB_DEFAULT_BASE_URL}
          disabled={orgLocked}
        />
      </Field>
      <Field label={t("integrations.gitlab.path")} hint={t("integrations.gitlab.pathHint")} required>
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
      <TestOutcome error={b.test.error} result={b.test.result} okText={t("integrations.gitlab.connectedTo", { host: gitlabHost(form.baseUrl) })} />
      {existing && <GitlabWebhookPanel projectId={projectId} bindingId={existing.id} />}
      <SingleBindingFooter b={b} canSave={canSave} onSave={handleSave} />
    </ProviderCard>
  );
}
