"use client";

import { Badge, type BadgeProps, Banner, Button, PageSection, PageSectionBody, PageSectionHeader, PageSectionTitle } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { type ReactNode, useState } from "react";
import { IntegrationEnabledControl } from "../components/integration-enabled-control";
import { useDeleteProviderIntegration, useTestIntegration } from "../hooks";
import type { IntegrationSummary, IntegrationTestResult } from "../types";

export interface BadgeView {
  label: string;
  tone: NonNullable<BadgeProps["tone"]>;
}

/** A binding's health as a badge; each provider names its own states, the rest default. */
export function healthBadge(
  binding: IntegrationSummary | undefined,
  names: { ok?: string; error?: string; needsReauth?: string; inactive?: BadgeView } = {},
): BadgeView {
  if (!binding) return { label: "Not configured", tone: "amber" };
  if (!binding.active) return names.inactive ?? { label: "Disabled", tone: "neutral" };
  if (binding.lastHealthStatus === "ok") return { label: names.ok ?? "Connected", tone: "green" };
  if (binding.lastHealthStatus === "needs_reauth" && names.needsReauth)
    return { label: names.needsReauth, tone: "red" };
  if (binding.lastHealthStatus === "error") return { label: names.error ?? "Error", tone: "red" };
  return { label: "Untested", tone: "neutral" };
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

export function activeBadge(existing: IntegrationSummary | undefined): BadgeView | null {
  if (!existing) return null;
  return existing.active ? { label: "Active", tone: "green" } : { label: "Disabled", tone: "neutral" };
}

export function OrgLockedNote({ children }: { children?: ReactNode }) {
  return (
    <p className="fg-body-sm text-muted">
      {children ?? "Org-shared credential — only an org owner/admin can change it."}
    </p>
  );
}

/** An error, then the last test's answer: `okText` replaces the server's message when given. */
export function TestOutcome({
  error,
  result,
  okFallback = "Connection OK",
  okText,
}: {
  error?: string | null;
  result: IntegrationTestResult | null;
  okFallback?: string;
  okText?: string;
}) {
  return (
    <>
      {error && <Banner tone="danger">{error}</Banner>}
      {result &&
        (result.status === "ok" ? (
          <Banner tone="success">{okText ?? result.message ?? okFallback}</Banner>
        ) : (
          <Banner tone="danger">{result.message ?? "Connection failed"}</Banner>
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
  deleteLabel = "Delete",
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
  return (
    <div className="flex flex-wrap items-center gap-2">
      {!orgLocked &&
        (rotating ? (
          <>
            <Button variant="primary" onClick={onSave} loading={saving} disabled={saveDisabled}>
              {saveLabel}
            </Button>
            <Button variant="secondary" onClick={() => setRotating(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={() => setRotating(true)}>
            {rotateLabel}
          </Button>
        ))}
      <Button variant="secondary" onClick={onTest} loading={testing}>
        Test
      </Button>
      <IntegrationEnabledControl projectId={projectId} binding={binding} />
      <Button
        variant="danger"
        icon="trash"
        loading={remove.isPending}
        onClick={() => window.confirm(confirmDelete) && remove.mutate(binding)}
      >
        {deleteLabel}
      </Button>
    </div>
  );
}
