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

/** Core's cap on a landing (`MERGED_LANDING_MAX`). Said and enforced here, never silently cut. */
const LANDING_MAX = 2000;

const BLURB =
  "For work finished outside the pipeline. This is a claim that the code shipped, not a date " +
  "field: it is what lets the issue close, because `closed` means the work shipped and a close " +
  "without it is refused. It does not release the issues blocked on this one — a status does " +
  "that. Unmark withdraws a claim made wrongly, and is refused once the issue is closed: " +
  "reopen it first, because a closed issue with no claim is a state nothing here can hold.";

// ISS-1327 — on a project whose work lands outside git there is no branch to name: what landed is
// a live page, a CMS entry, a storefront resource, and the close accepts a mark only if it says so.
const LANDING_BLURB =
  "This project's work lands outside git, so say where it landed: the live URL, the CMS entry or " +
  "the storefront resource the work now is. That is what lets the issue close — a mark naming no " +
  "landing is not accepted here. It does not release the issues blocked on this one — a status " +
  "does that. Unmark withdraws a claim made wrongly, and is refused once the issue is closed.";

interface MergeMarkerControlProps {
  issueId: string;
  /** `null` when no claim has been made — the control offers to make one. */
  mergedAt: string | null;
  /** Default `target`, offered because the repo's branch convention is `ISS-<seq>`. */
  suggestedTarget: string;
  /** Core's answer for this issue's project; an older server that sends none reads as `git`. */
  landingShape?: LandingShape | null | undefined;
}

export function MergeMarkerControl({
  issueId,
  mergedAt,
  suggestedTarget,
  landingShape,
}: MergeMarkerControlProps) {
  const outsideGit = landingShape === "outside_git";
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(outsideGit ? "" : suggestedTarget);
  const [note, setNote] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const marker = useMergeMarker(issueId);

  useEffect(() => {
    if (open) {
      setTarget(outsideGit ? "" : suggestedTarget);
      setNote("");
      setRefusal(null);
    }
  }, [open, suggestedTarget, outsideGit]);

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
        Mark merged
      </Button>
      {open && (
        <SlideOver open onClose={() => setOpen(false)} title="Mark this work merged" width={480}>
          <div className="flex h-full flex-col gap-4">
            <p className="fg-body-sm text-muted">{outsideGit ? LANDING_BLURB : BLURB}</p>
            <Field
              label="Where it landed"
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
                    : "e.g. ISS-791, or the branch or PR it merged through"
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
