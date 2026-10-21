"use client";

// Small reusable confirm modal for destructive/irreversible actions (remove
// member, revoke invitation, delete org, delete a private key). Wraps the
// SlideOver pattern (focus-trap + Esc-to-close + focus-restore already built
// in). Presentational only — the caller owns the mutation and clears state in
// onConfirm/onClose.

import type { ReactNode } from "react";
import { SlideOver } from "@/design/patterns/slide-over";
import { Banner } from "@/design/primitives/banner";
import { Button } from "@/design/primitives/button";

export interface PanelFailureView {
  title: string;
  description: string;
}

export function PanelFailure({ failure }: { failure: PanelFailureView }) {
  return (
    <div role="alert" data-testid="panel-failure">
      <Banner tone="danger">
        <span className="block font-medium">{failure.title}</span>
        <span className="block">{failure.description}</span>
      </Banner>
    </div>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  /** What the button that keeps things as they are says. */
  cancelLabel?: string;
  /** `danger` renders a red confirm button for destructive actions. */
  tone?: "danger" | "default";
  loading?: boolean;
  /** A refusal is told inside the panel, never in a toast drawn over it (ISS-1229 r28). */
  failure?: PanelFailureView | null;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "default",
  loading = false,
  failure = null,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  return (
    <SlideOver open={open} onClose={onClose} title={title} width={420}>
      <div className="flex h-full flex-col gap-4">
        <p className="fg-body-sm text-fg">{message}</p>
        {failure && <PanelFailure failure={failure} />}
        <div className="mt-auto flex items-center justify-end gap-2.5 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={tone === "danger" ? "danger" : "primary"}
            loading={loading}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </SlideOver>
  );
}
