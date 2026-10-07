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
import { useCopy } from "@/lib/i18n/interface-language";
import { useMergeMarker } from "../hooks";
import type { LandingShape } from "../types";

/** Core's cap on a landing (`MERGED_LANDING_MAX`). Said and enforced here, never silently cut. */
const LANDING_MAX = 2000;

// ISS-1327 — on a project whose work lands outside git there is no branch to name: what landed is
// a live page, a CMS entry, a storefront resource, and the close accepts a mark only if it says so
// (`issues.merge.landingBlurb`, beside the git reading `issues.merge.blurb`).

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
  const t = useCopy();

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
        {t("issues.merge.unmark")}
      </Button>
    );
  }

  const trimmedTarget = target.trim();
  const overLimit = outsideGit && trimmedTarget.length > LANDING_MAX;

  return (
    <>
      <Button variant="ghost" size="sm" icon="check" onClick={() => setOpen(true)}>
        {t("issues.merge.mark")}
      </Button>
      {open && (
        <SlideOver open onClose={() => setOpen(false)} title={t("issues.merge.title")} width={480}>
          <div className="flex h-full flex-col gap-4">
            <p className="fg-body-sm text-muted">{outsideGit ? t("issues.merge.landingBlurb") : t("issues.merge.blurb")}</p>
            <Field
              label={t("issues.merge.where")}
              required
              error={
                overLimit
                  ? t("issues.merge.tooLong", { max: LANDING_MAX, n: trimmedTarget.length })
                  : undefined
              }
            >
              <Input
                value={target}
                placeholder={
                  outsideGit
                    ? t("issues.merge.landingPlaceholder")
                    : t("issues.merge.targetPlaceholder")
                }
                onChange={(e) => {
                  setTarget(e.target.value);
                  setRefusal(null);
                }}
              />
            </Field>
            <Field label={t("issues.merge.note")}>
              <Textarea
                rows={4}
                value={note}
                placeholder={t("issues.merge.notePlaceholder")}
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
                {t("common.cancel")}
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
                {t("issues.merge.mark")}
              </Button>
            </div>
          </div>
        </SlideOver>
      )}
    </>
  );
}
