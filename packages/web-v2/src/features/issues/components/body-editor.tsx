"use client";

// The textarea a body is written in, plus the two things ISS-967 gives an
// author: a menu that inserts a component without typing markup, and a pane
// showing what the kernel would store — both answered by `/api/body`, so the
// menu offers exactly what a save accepts and the pane draws exactly what a
// save would keep. Used by the description editor and by the comment composer.

import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useMemo, useRef, useState } from "react";
import {
  BodyView,
  Button,
  Menu,
  PreviewPane,
  Spinner,
  Textarea,
  useDebounced,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { bodyApi, componentSkeleton } from "../body-api";

const PREVIEW_DEBOUNCE_MS = 300;

export interface BodyEditorProps {
  value: string;
  onChange: (next: string) => void;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  label: string;
  /** Drawn on the toolbar row beside Insert — the caller's Save/Cancel. */
  actions?: ReactNode;
}

export function BodyEditor({
  value,
  onChange,
  rows = 10,
  placeholder,
  disabled,
  label,
  actions,
}: BodyEditorProps) {
  const [showPreview, setShowPreview] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const debounced = useDebounced(value, PREVIEW_DEBOUNCE_MS);

  const registry = useQuery({
    queryKey: ["body", "components"],
    queryFn: () => bodyApi.components(),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const preview = useQuery({
    queryKey: ["body", "preview", debounced],
    queryFn: () => bodyApi.preview(debounced),
    enabled: showPreview && debounced.trim().length > 0,
    retry: false,
  });

  const insertItems = useMemo(() => {
    const specs = registry.data ?? [];
    const byName = new Map(specs.map((s) => [s.name, s]));
    return specs
      .filter((s) => s.root)
      .map((spec) => ({
        label: spec.name,
        onSelect: () => {
          const snippet = componentSkeleton(spec, byName);
          const el = ref.current;
          const at = el ? el.selectionStart : value.length;
          const before = value.slice(0, at);
          const after = value.slice(at);
          const pad = before && !before.endsWith("\n") ? "\n\n" : "";
          onChange(`${before}${pad}${snippet}${after}`);
          el?.focus();
        },
      }));
  }, [registry.data, value, onChange]);

  return (
    <div className="space-y-2">
      <Textarea
        ref={ref}
        rows={rows}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Menu
            align="left"
            // cm:guard the trigger must be a real interactive element: `Menu` deliberately wraps it in a plain `<span>` carrying only the popup semantics, so a `<span>` here is a menu no keyboard can open.
            trigger={
              <Button variant="ghost" size="sm" disabled={disabled}>
                Insert component
              </Button>
            }
            items={
              insertItems.length > 0
                ? insertItems
                : [{ label: registry.isError ? "Couldn't load components" : "Loading…" }]
            }
          />
          <PreviewPane
            open={showPreview}
            onToggle={() => setShowPreview((p) => !p)}
            status={
              preview.isFetching ? (
                <p className="fg-caption flex items-center gap-2 text-muted">
                  <Spinner size={12} /> Checking…
                </p>
              ) : preview.isError ? (
                // cm:guard the refusal is the kernel's own message, which names the element, the attribute and its legal set — replacing it with a generic line removes the only thing that tells an author what to change (ISS-898's whole compliance result).
                <p className="fg-body-sm text-[color:var(--red-600)]">
                  {formatApiError(preview.error)}
                </p>
              ) : null
            }
          >
            {preview.data ? (
              <BodyView
                body={preview.data.body}
                format={preview.data.format}
                nodes={preview.data.nodes}
              />
            ) : preview.isError ? null : (
              <p className="fg-body-sm text-muted">Nothing to preview yet.</p>
            )}
          </PreviewPane>
        </div>
        {actions}
      </div>
    </div>
  );
}
