"use client";

import { Badge, Button } from "@/design";
import { type ReactNode, useMemo, useState } from "react";
import { useIntegrationsList } from "../hooks";
import type { IntegrationSummary } from "../types";
import { type BadgeView, ProviderCard } from "./shared";

/** A section listing several labelled bindings of one provider, with an Add form below them. */
export function MultiBindingSection({
  projectId,
  provider,
  title,
  intro,
  emptyText,
  addLabel,
  renderRow,
  renderAdd,
}: {
  projectId: string;
  provider: string;
  title: string;
  intro: ReactNode;
  emptyText: string;
  addLabel: string;
  renderRow: (binding: IntegrationSummary, isDefault: boolean) => ReactNode;
  renderAdd: (hasDefault: boolean, onDone: () => void) => ReactNode;
}) {
  const list = useIntegrationsList(projectId);
  // Oldest first — the order the resolver reads them in, so the first is the default.
  const bindings = useMemo(
    () =>
      (list.data?.items ?? [])
        .filter((i) => i.provider === provider)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    [list.data, provider],
  );
  const isLoading = list.isLoading;
  const [adding, setAdding] = useState(false);
  return (
    <ProviderCard
      title={title}
      badge={bindings.length > 0 ? { label: `${bindings.length} connected`, tone: "green" } : null}
    >
      <p className="fg-body-sm text-muted">{intro}</p>
      {isLoading && <p className="fg-body-sm text-muted">Loading…</p>}
      {!isLoading && bindings.length === 0 && <p className="fg-body-sm text-muted italic">{emptyText}</p>}
      {bindings.map((binding, idx) => renderRow(binding, idx === 0))}
      {adding ? (
        renderAdd(bindings.length > 0, () => setAdding(false))
      ) : (
        <Button className="self-start" variant="secondary" onClick={() => setAdding(true)}>
          {addLabel}
        </Button>
      )}
    </ProviderCard>
  );
}

/** A labelled binding's header: its label (or "default"), the default marker, its health. */
export function BindingRowHeader({
  binding,
  isDefault,
  badge,
  monoDefault = false,
}: {
  binding: IntegrationSummary;
  isDefault: boolean;
  badge: BadgeView;
  /** Set the unlabelled name in the label's own mono face rather than muted. */
  monoDefault?: boolean;
}) {
  const label = binding.label;
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        {label || monoDefault ? (
          <span className="font-mono text-sm font-semibold">{label || "default"}</span>
        ) : (
          <span className="fg-body-sm font-semibold text-muted">default</span>
        )}
        {isDefault && <Badge tone="neutral">default</Badge>}
      </div>
      <Badge tone={badge.tone}>{badge.label}</Badge>
    </div>
  );
}
