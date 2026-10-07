"use client";

import { Banner, Field, Input } from "@/design";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { ConnectionOwnerField } from "../../components/connection-owner-field";
import type { IntegrationSummary, SentryConfig } from "../../types";
import { activeBadge, OrgLockedNote, ProviderCard, TestOutcome, Ticked } from "../shared";
import { providerLabel } from "../registry";
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

function oldShapeText(retired: string[], t: Copy): string {
  return `target_old_shape: ${t("integrations.sentry.oldShape", { keys: retired.map((k) => `\`${k}\``).join(t("integrations.sentry.and")) })}`;
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
  const t = useCopy();
  const language = useInterfaceLanguage();
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
    <ProviderCard title={providerLabel("sentry", language)} badge={activeBadge(existing, t)}>
      <p className="fg-body-sm text-muted">{t("integrations.sentry.intro")}</p>
      {retired.length > 0 && (
        <Banner tone="danger">
          <Ticked text={oldShapeText(retired, t)} />
        </Banner>
      )}
      <Field
        label={t("integrations.sentry.host")}
        hint={t("integrations.sentry.hostHint")}
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
        label={t("integrations.sentry.token")}
        hint={existing ? t("integrations.provider.tokenStored") : t("integrations.sentry.tokenHint")}
        required={!existing}
      >
        <Input
          type="password"
          autoComplete="off"
          placeholder={existing ? t("integrations.provider.unchanged") : "sntryu_…"}
          value={form.authToken}
          onChange={(e) => set("authToken", e.target.value)}
          disabled={orgLocked}
        />
      </Field>
      {orgLocked && <OrgLockedNote />}
      {!existing && <ConnectionOwnerField projectId={projectId} value={b.ownerOrgId} onChange={b.setOwnerOrgId} />}
      <SentryTargetsField targets={form.targets} onChange={(next) => set("targets", next)} disabled={orgLocked} />
      <TestOutcome error={b.test.error} result={b.test.result} okFallback={t("integrations.provider.connectedDot")} />
      <SingleBindingFooter b={b} canSave={canSave} onSave={handleSave} />
    </ProviderCard>
  );
}
