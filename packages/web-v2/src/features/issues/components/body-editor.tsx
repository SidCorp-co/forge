"use client";

// The textarea a body is written in, plus a pane showing what the kernel would
// store. Used by the description editor and by the comment composer.
//
// ISS-967 also gave this toolbar a menu that inserted a `forge-*` component
// skeleton; the owner cut it on 2026-09-14 as the wrong direction. The pane
// stays because it answers a question the menu did not: `/api/body/preview`
// runs the same `prepareBody` a save runs, so it draws the bytes that would be
// stored and reports the refusal that would be answered — for a body written
// or pasted by hand as well as for the markdown that is nearly all of them.

import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { BodyView, PreviewPane, Spinner, Textarea, useDebounced } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { bodyApi } from "../body-api";

const PREVIEW_DEBOUNCE_MS = 300;

export interface BodyEditorProps {
  value: string;
  onChange: (next: string) => void;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  label: string;
  /** Drawn on the toolbar row beside Preview — the caller's Save/Cancel. */
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
  const debounced = useDebounced(value, PREVIEW_DEBOUNCE_MS);

  const preview = useQuery({
    queryKey: ["body", "preview", debounced],
    queryFn: () => bodyApi.preview(debounced),
    enabled: showPreview && debounced.trim().length > 0,
    retry: false,
  });

  return (
    <div className="space-y-2">
      <Textarea
        rows={rows}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
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
