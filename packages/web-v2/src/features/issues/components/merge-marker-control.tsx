// ISS-791 — the shipped-work claim, on the surface humans actually use.
//
// `POST /api/issues/:id/merge` existed only for the CLI and MCP, so a person who finished an issue
// by hand could only close it — and a close auto-stamps `merged_at` inside its own transaction,
// which `issues/progress.ts` correctly discounts. The work was therefore counted as "closed with
// NO evidence it shipped" with no way for the person who shipped it to say otherwise.

"use client";

import { useEffect, useState } from "react";
import { Button, Field, Input, Textarea } from "@/design";
import { SlideOver } from "@/design/patterns/slide-over";
import { useMergeMarker } from "../hooks";

// cm:guard plain prose only — this renders in a bare <p>, so markdown backticks would reach the user as literal characters (the same rule transition-reason-dialog.tsx carries, caught on forge-beta 2026-08-14)
const BLURB =
  "For work finished outside the pipeline. This is a claim that the code shipped, not a date " +
  "field: it is what counts the issue as shipped rather than closed-with-no-evidence, and it " +
  "releases every issue that was blocked on this one. Unmark reverses both.";

interface MergeMarkerControlProps {
  issueId: string;
  /** `null` when no claim has been made — the control offers to make one. */
  mergedAt: string | null;
  /** Default `target`, offered because the repo's branch convention is `ISS-<seq>`. */
  suggestedTarget: string;
}

export function MergeMarkerControl({ issueId, mergedAt, suggestedTarget }: MergeMarkerControlProps) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(suggestedTarget);
  const [note, setNote] = useState("");
  const marker = useMergeMarker(issueId);

  useEffect(() => {
    if (open) {
      setTarget(suggestedTarget);
      setNote("");
    }
  }, [open, suggestedTarget]);

  if (mergedAt) {
    return (
      <Button
        variant="ghost"
        size="sm"
        disabled={marker.isPending}
        onClick={() => marker.unmark()}
      >
        Unmark
      </Button>
    );
  }

  const trimmedTarget = target.trim();

  return (
    <>
      <Button variant="ghost" size="sm" icon="check" onClick={() => setOpen(true)}>
        Mark merged
      </Button>
      {open && (
        <SlideOver open onClose={() => setOpen(false)} title="Mark this work merged" width={480}>
          <div className="flex h-full flex-col gap-4">
            <p className="fg-body-sm text-muted">{BLURB}</p>
            <Field label="Where it landed" required>
              <Input
                value={target}
                placeholder="e.g. ISS-791, or the branch or PR it merged through"
                onChange={(e) => setTarget(e.target.value)}
              />
            </Field>
            <Field label="Note">
              <Textarea
                rows={4}
                value={note}
                placeholder="e.g. driven by hand on 2026-09-06, CI green, merged by the repo owner"
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
            <div className="mt-auto flex items-center justify-end gap-2.5 pt-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpen(false)}
                disabled={marker.isPending}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="primary"
                loading={marker.isPending}
                disabled={trimmedTarget.length === 0}
                onClick={() => {
                  marker.mark({
                    target: trimmedTarget,
                    ...(note.trim() ? { note: note.trim() } : {}),
                  });
                  setOpen(false);
                }}
              >
                Mark merged
              </Button>
            </div>
          </div>
        </SlideOver>
      )}
    </>
  );
}
