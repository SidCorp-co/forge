"use client";

import { Banner, Field, Input } from "@/design";
import { ConnectionOwnerField } from "../../components/connection-owner-field";
import type { IntegrationSummary, SentryConfig } from "../../types";
import { activeBadge, OrgLockedNote, ProviderCard, TestOutcome } from "../shared";
import { SingleBindingFooter, useSingleBinding } from "../single-binding";
import { sentry } from "./index";
import { initialTargets, rowInvalid, SentryTargetsField, type TargetRow, toTargets } from "./targets-field";

interface FormState {
  authToken: string;
  host: string;
  targets: TargetRow[];
}

/** The top-level slugs ISS-526 retired that a stored config still carries. Core refuses such a
 *  binding as `target_old_shape` and reads none of its targets, so the screen says so instead. */
function retiredSlugs(cfg: Record<string, unknown>): string[] {
  return (["organizationSlug", "projectSlug"] as const).filter((k) => cfg[k] != null);
}

function oldShapeText(retired: string[]): string {
  return (
    `target_old_shape: this binding's config carries ${retired.map((k) => `\`${k}\``).join(" and ")} ` +
    "at its top level, the Sentry shape ISS-526 retired, so Forge refuses it and no Sentry project " +
    "reaches the agents. A save cannot clear those keys: remove this integration and connect it " +
    "again, naming each Sentry project under Sentry projects."
  );
}

function initialForm(existing: IntegrationSummary | undefined): FormState {
  const cfg = (existing?.config ?? {}) as Partial<SentryConfig>;
  return { authToken: "", host: cfg.host ?? "", targets: initialTargets(cfg) };
}

/**
 * ISS-524 / ISS-526 — one connection (host + write-only auth token) maps to a list of labelled
 * targets. The official `@sentry/mcp-server` tools reach the project's agents only where the
 * binding's `agentAccess` grant is on; the target list is surfaced in the agent's prompt.
 */
export function SentrySection({ projectId }: { projectId: string }) {
  const b = useSingleBinding(projectId, sentry, initialForm);
  const { existing, form, set, orgLocked } = b;
  const retired = retiredSlugs((existing?.config ?? {}) as Record<string, unknown>);
  const canSave =
    form.host.trim().length > 0 &&
    (existing !== undefined || form.authToken.trim().length >= 8) &&
    !form.targets.some(rowInvalid) &&
    retired.length === 0 &&
    !b.saving &&
    !orgLocked;

  async function handleSave() {
    b.test.reset();
    const config = { host: form.host.trim(), targets: toTargets(form.targets) };
    const authToken = form.authToken.trim();
    await b.save(config, ["authToken", authToken]);
    set("authToken", "");
  }

  return (
    <ProviderCard title="Sentry" badge={activeBadge(existing)}>
      <p className="fg-body-sm text-muted">
        Store one Sentry host + auth token, then register every Sentry project it can read (e.g.
        backend, frontend, mobile). The official Sentry MCP tools reach this project&apos;s agents only
        once the grant below is on; the target list is then shared with them so they query the right
        org/project.
      </p>
      {retired.length > 0 && <Banner tone="danger">{oldShapeText(retired)}</Banner>}
      <Field
        label="Sentry host"
        hint="The Sentry instance host without scheme, e.g. logs.canawan.com or sentry.io."
        required={!existing || !form.host.trim()}
      >
        <Input
          value={form.host}
          onChange={(e) => set("host", e.target.value)}
          placeholder="logs.canawan.com"
          disabled={orgLocked}
        />
      </Field>
      <Field
        label="Auth token"
        hint={
          existing
            ? "A token is stored. Leave blank to keep it; enter a new one to rotate."
            : "Sentry user auth token (sntryu-…). Stored encrypted; never shown again."
        }
        required={!existing}
      >
        <Input
          type="password"
          autoComplete="off"
          placeholder={existing ? "•••••••• (unchanged)" : "sntryu_…"}
          value={form.authToken}
          onChange={(e) => set("authToken", e.target.value)}
          disabled={orgLocked}
        />
      </Field>
      {orgLocked && <OrgLockedNote />}
      {!existing && <ConnectionOwnerField projectId={projectId} value={b.ownerOrgId} onChange={b.setOwnerOrgId} />}
      <SentryTargetsField targets={form.targets} onChange={(t) => set("targets", t)} disabled={orgLocked} />
      <TestOutcome error={b.test.error} result={b.test.result} okFallback="Connected." />
      <SingleBindingFooter b={b} canSave={canSave} onSave={handleSave} />
    </ProviderCard>
  );
}
