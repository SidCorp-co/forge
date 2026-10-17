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
import { formatApiError } from "@/lib/api/error";
import { useMergeMarker } from "../hooks";
import type { LandingShape } from "../types";
import { MARK_MERGED_ACTION, WHERE_IT_LANDED_FIELD, WORK_LANDS_ROW } from "@forge/contracts/mark-merged-words";

/** Core's cap on a landing (`MERGED_LANDING_MAX`). Said and enforced here, never silently cut. */
const LANDING_MAX = 2000;

/** Two short sentences: what the mark does, and how it is undone (ISS-1421, criterion 85). */
export const BLURB =
  "Marking merged says this work shipped, which lets the issue close. Unmark takes it back, unless the issue is closed.";

/** Outside git the mark names where the work now is, since there is no branch to name (ISS-1327). */
export const LANDING_BLURB =
  "Say where the work now is: the live URL, the CMS entry or the storefront resource. " +
  "Marking merged lets the issue close. Unmark takes it back, unless the issue is closed.";

interface MergeMarkerControlProps {
  issueId: string;
  /** `null` when no claim has been made — the control offers to make one. */
  mergedAt: string | null;
  /** Core's answer for this issue's lane; an older server that sends none reads as `git`. */
  landingShape?: LandingShape | undefined;
  /** Whose answer `landingShape` is: the issue's own declaration, or its project's shape. Absent
   *  where the server does not say, and then the panel names no source. */
  landingSource?: "issue" | "project" | undefined;
}

/** Where this issue's work lands and who said so, since the two can differ. */
function landingLine(shape: LandingShape, source: "issue" | "project" | undefined): string {
  const where = shape === "outside_git" ? "outside git" : "in git";
  if (source === "issue") return `This issue's work lands ${where}: the issue declares it itself, under ${WORK_LANDS_ROW}.`;
  if (source === "project") return `This issue's work lands ${where}: that is its project's shape.`;
  return `This issue's work lands ${where}.`;
}

export function MergeMarkerControl({
  issueId,
  mergedAt,
  landingShape,
  landingSource,
}: MergeMarkerControlProps) {
  const outsideGit = landingShape === "outside_git";
  const [open, setOpen] = useState(false);
  // Starts empty: whatever it holds is sent as where the work landed, so a value filled in for the
  // reader (once the issue's own key) became a mark saying the work merged into the issue.
  const [target, setTarget] = useState("");
  const [note, setNote] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const marker = useMergeMarker(issueId);

  useEffect(() => {
    if (open) {
      setTarget("");
      setNote("");
      setRefusal(null);
    }
  }, [open]);

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
  const overLimit = outsideGit && trimmedTarget.length > LANDING_MAX;

  return (
    <>
      <Button variant="ghost" size="sm" icon="check" onClick={() => setOpen(true)}>
        {MARK_MERGED_ACTION}
      </Button>
      {open && (
        <SlideOver open onClose={() => setOpen(false)} title="Mark this work merged" width={480}>
          <div className="flex h-full flex-col gap-4">
            <p className="fg-body-sm text-fg" data-testid="landing-line">
              {landingLine(outsideGit ? "outside_git" : "git", landingSource)}
            </p>
            <p className="fg-body-sm text-muted">{outsideGit ? LANDING_BLURB : BLURB}</p>
            <Field
              label={WHERE_IT_LANDED_FIELD}
              required
              error={
                overLimit
                  ? `At most ${LANDING_MAX} characters — this is ${trimmedTarget.length}. Nothing was cut; shorten it to send it.`
                  : undefined
              }
            >
              <Input
                value={target}
                placeholder={
                  outsideGit
                    ? "e.g. https://shop.example.com/products/linen-tee, or the CMS entry it is"
                    : "e.g. main, or the branch or PR it merged into"
                }
                onChange={(e) => {
                  setTarget(e.target.value);
                  setRefusal(null);
                }}
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
            {refusal && (
              <p
                role="alert"
                className="fg-body-sm rounded-md border border-line bg-surface-subtle px-3 py-2"
                style={{ color: "var(--red-600)" }}
              >
                {refusal}
              </p>
            )}
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
                disabled={trimmedTarget.length === 0 || overLimit}
                onClick={() => {
                  setRefusal(null);
                  marker.mark(
                    {
                      // A project that moves no branch names no target: the landing is where it landed.
                      ...(outsideGit ? { landing: trimmedTarget } : { target: trimmedTarget }),
                      ...(note.trim() ? { note: note.trim() } : {}),
                    },
                    // Closed on success only: a refused mark keeps what was typed, and says why.
                    { onSuccess: () => setOpen(false), onError: (err) => setRefusal(formatApiError(err)) },
                  );
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
