"use client";

import { Badge, type BadgeProps, Banner, Button, PageSection, PageSectionBody, PageSectionHeader, PageSectionTitle } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { type ReactNode, useState } from "react";
import { IntegrationEnabledControl } from "../components/integration-enabled-control";
import { useDeleteProviderIntegration, useTestIntegration } from "../hooks";
import type { IntegrationSummary, IntegrationTestResult } from "../types";

/** A sentence whose `backticked` spans are identifiers, set in the mono face. */
export function Ticked({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((part, i) =>
        part.startsWith("`") && part.endsWith("`") && part.length > 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed sentence never reorder
          <span key={i} className="font-mono" translate="no">
            {part.slice(1, -1)}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

export interface BadgeView {
  label: string;
  tone: NonNullable<BadgeProps["tone"]>;
}

/** A binding's health as a badge; each provider names its own states (already worded), the rest default. */
export function healthBadge(
  binding: IntegrationSummary | undefined,
  t: Copy,
  names: { ok?: string; error?: string; needsReauth?: string; inactive?: BadgeView } = {},
): BadgeView {
  if (!binding) return { label: t("integrations.mcp.notConfigured"), tone: "amber" };
  if (!binding.active) return names.inactive ?? { label: t("integrations.status.disabled"), tone: "neutral" };
  if (binding.lastHealthStatus === "ok") return { label: names.ok ?? t("integrations.status.connected"), tone: "green" };
  if (binding.lastHealthStatus === "needs_reauth" && names.needsReauth)
    return { label: names.needsReauth, tone: "red" };
  if (binding.lastHealthStatus === "error") return { label: names.error ?? t("integrations.provider.error"), tone: "red" };
  return { label: t("integrations.provider.untested"), tone: "neutral" };
}

/** A provider's card: title, an optional badge, and its content stacked. */
export function ProviderCard({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: BadgeView | null;
  children: ReactNode;
}) {
  return (
    <PageSection>
      <PageSectionHeader>
        <div className="flex items-center justify-between gap-2">
          <PageSectionTitle>{title}</PageSectionTitle>
          {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
        </div>
      </PageSectionHeader>
      <PageSectionBody>
        <div className="flex flex-col gap-4">{children}</div>
      </PageSectionBody>
    </PageSection>
  );
}

export function activeBadge(existing: IntegrationSummary | undefined, t: Copy): BadgeView | null {
  if (!existing) return null;
  return existing.active
    ? { label: t("integrations.provider.active"), tone: "green" }
    : { label: t("integrations.status.disabled"), tone: "neutral" };
}

export function OrgLockedNote({ children }: { children?: ReactNode }) {
  const t = useCopy();
  return <p className="fg-body-sm text-muted">{children ?? t("integrations.provider.orgLocked")}</p>;
}

/** An error, then the last test's answer: `okText` replaces the server's message when given. */
export function TestOutcome({
  error,
  result,
  okFallback,
  okText,
}: {
  error?: string | null;
  result: IntegrationTestResult | null;
  okFallback?: string;
  okText?: string;
}) {
  const t = useCopy();
  return (
    <>
      {error && <Banner tone="danger">{error}</Banner>}
      {result &&
        (result.status === "ok" ? (
          <Banner tone="success">{okText ?? result.message ?? okFallback ?? t("integrations.provider.connectionOk")}</Banner>
        ) : (
          <Banner tone="danger">{result.message ?? t("integrations.provider.connectionFailed")}</Banner>
        ))}
    </>
  );
}

/** A binding's Test button state: the answer, or the error the call threw. */
export function useBindingTest(projectId: string, afterTest?: () => void) {
  const test = useTestIntegration(projectId);
  const [result, setResult] = useState<IntegrationTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reset = () => {
    setResult(null);
    setError(null);
  };
  async function run(bindingId: string | undefined) {
    if (!bindingId) return;
    reset();
    try {
      setResult(await test.mutateAsync(bindingId));
      afterTest?.();
    } catch (err) {
      setError(formatApiError(err));
    }
  }
  return { result, error, setError, reset, run, pending: test.isPending };
}

/**
 * A saved binding's action row: replace its secret (Save / Cancel while open), Test, Enabled, and a
 * confirmed delete.
 */
export function BindingRowActions({
  projectId,
  binding,
  orgLocked,
  rotating,
  setRotating,
  rotateLabel,
  saveLabel,
  onSave,
  saving,
  saveDisabled,
  onTest,
  testing,
  confirmDelete,
  deleteLabel,
}: {
  projectId: string;
  binding: IntegrationSummary;
  orgLocked: boolean;
  rotating: boolean;
  setRotating: (open: boolean) => void;
  rotateLabel: string;
  saveLabel: string;
  onSave: () => void;
  saving: boolean;
  saveDisabled: boolean;
  onTest: () => void;
  testing: boolean;
  confirmDelete: string;
  deleteLabel?: string;
}) {
  const remove = useDeleteProviderIntegration(projectId);
  const t = useCopy();
  return (
    <div className="flex flex-wrap items-center gap-2">
      {!orgLocked &&
        (rotating ? (
          <>
            <Button variant="primary" onClick={onSave} loading={saving} disabled={saveDisabled}>
              {saveLabel}
            </Button>
            <Button variant="secondary" onClick={() => setRotating(false)}>
              {t("common.cancel")}
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={() => setRotating(true)}>
            {rotateLabel}
          </Button>
        ))}
      <Button variant="secondary" onClick={onTest} loading={testing}>
        {t("integrations.provider.test")}
      </Button>
      <IntegrationEnabledControl projectId={projectId} binding={binding} />
      <Button
        variant="danger"
        icon="trash"
        loading={remove.isPending}
        onClick={() => window.confirm(confirmDelete) && remove.mutate(binding)}
      >
        {deleteLabel ?? t("integrations.row.delete")}
      </Button>
    </div>
  );
}
