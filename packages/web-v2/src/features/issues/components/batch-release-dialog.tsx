"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Banner, Button, MonoTag, Radio, RadioGroup, SlideOver, Textarea } from "@/design";
import { inlineCode } from "@/features/project-settings/components/inline-code";
import { ApiError } from "@/lib/api/client";
import { formatApiError } from "@/lib/api/error";
import type { CarriedDecisionBody } from "../api";
import { useBatchRelease } from "../hooks";

/** Minimal issue shape required by the dialog — avoids coupling to the full IssueRow. */
export interface BatchReleaseIssue {
  id: string;
  displayId: string;
  title: string;
}

/** An issue the release's range carries that the roster does not name (ISS-1386). */
interface CarriedIssue {
  issueId: string;
  displayId: string;
  status: string;
}

type CarriedChoice = { decision: CarriedDecisionBody["decision"] | ""; why: string };

const CHOICES: Array<{ value: CarriedDecisionBody["decision"]; label: string }> = [
  { value: "ship-unverified", label: "Ship unverified" },
  { value: "revert", label: "Reverted" },
  { value: "cut-below", label: "Cut below" },
];

/** The carried issues a refusal names, read off its details rather than out of its prose. */
function carriedIn(err: unknown): CarriedIssue[] | null {
  if (!(err instanceof ApiError) || err.code !== "RELEASE_CARRIES_UNDECIDED") return null;
  const listed = (err.details as { carried?: unknown } | undefined)?.carried;
  if (!Array.isArray(listed)) return null;
  return listed.flatMap((i) =>
    i && typeof i.issueId === "string" && typeof i.displayId === "string"
      ? [{ issueId: i.issueId, displayId: i.displayId, status: String(i.status ?? "") }]
      : [],
  );
}

function decisionOf(issueId: string, choice: CarriedChoice | undefined): CarriedDecisionBody | null {
  if (!choice?.decision) return null;
  if (choice.decision !== "ship-unverified") return { issueId, decision: choice.decision };
  const why = choice.why.trim();
  return why ? { issueId, decision: "ship-unverified", why } : null;
}

export function BatchReleaseDialog({
  projectId,
  selectedIssues,
  open,
  onClose,
  onSuccess,
}: {
  projectId: string;
  selectedIssues: BatchReleaseIssue[];
  open: boolean;
  onClose: () => void;
  /** Called after a successful batch create so the parent can clear selection. */
  onSuccess: () => void;
}) {
  const openRef = useRef(open);
  openRef.current = open;
  const showsRefusal = useCallback(() => openRef.current, []);
  const batch = useBatchRelease(projectId, { showsRefusal });
  const { reset, isPending } = batch;
  const [refusal, setRefusal] = useState<{ message: string; tries: number } | null>(null);
  const [carried, setCarried] = useState<CarriedIssue[]>([]);
  const [choices, setChoices] = useState<Record<string, CarriedChoice>>({});

  // A refusal belongs to the press that met it, so a dialog opened again starts clean; a press
  // still in flight is kept, since resetting it would leave its answer nowhere to land.
  const pendingRef = useRef(isPending);
  pendingRef.current = isPending;
  useEffect(() => {
    if (!open) return;
    setRefusal(null);
    setCarried([]);
    setChoices({});
    if (!pendingRef.current) reset();
  }, [open, reset]);

  const decisions = carried.map((i) => decisionOf(i.issueId, choices[i.issueId]));
  const undecided = decisions.filter((d) => d === null).length;

  const choose = (issueId: string, patch: Partial<CarriedChoice>) =>
    setChoices((prev) => {
      const was = prev[issueId] ?? { decision: "", why: "" };
      return { ...prev, [issueId]: { ...was, ...patch } };
    });

  const handleConfirm = () => {
    const issueIds = selectedIssues.map((i) => i.id);
    const sent = decisions.filter((d): d is CarriedDecisionBody => d !== null);
    batch.mutate(
      { issueIds, ...(sent.length > 0 ? { carried: sent } : {}) },
      {
        onSuccess: () => {
          setRefusal(null);
          onClose();
          onSuccess();
        },
        onError: (err) => {
          const named = carriedIn(err);
          if (named) setCarried(named);
          setRefusal((prev) => ({ message: formatApiError(err), tries: (prev?.tries ?? 0) + 1 }));
        },
      },
    );
  };

  return (
    <SlideOver
      open={open}
      onClose={onClose}
      title="Batch release"
      width={400}
    >
      <div className="flex flex-col gap-4">
        <p className="fg-body-sm text-fg">
          The following {selectedIssues.length === 1 ? "issue" : `${selectedIssues.length} issues`} will
          be merged, deployed, and closed in one batch release. This cannot be undone.
        </p>

        <ul className="flex flex-col gap-1.5 rounded-lg border border-line bg-canvas p-3">
          {selectedIssues.map((issue) => (
            <li key={issue.id} className="fg-body-sm flex min-w-0 items-baseline gap-2">
              <span className="font-mono text-xs font-semibold text-fg shrink-0">{issue.displayId}</span>
              <span className="min-w-0 truncate text-muted">{issue.title}</span>
            </li>
          ))}
        </ul>

        {/* A toast paints beneath this drawer's scrim, so the refusal is said here and only here. */}
        {refusal && (
          <div role="alert">
            <Banner tone="danger">
              {isPending ? (
                <p className="font-medium">Sending try {refusal.tries + 1}…</p>
              ) : refusal.tries > 1 ? (
                <p className="font-medium">Try {refusal.tries} failed as well.</p>
              ) : null}
              <p>{inlineCode(refusal.message)}</p>
            </Banner>
          </div>
        )}

        {carried.length > 0 && (
          <section className="flex flex-col gap-3" aria-label="Issues this release carries">
            <p className="fg-body-sm text-fg">
              This release would also ship these issues. Decide each one before releasing.
            </p>
            {carried.map((issue) => {
              const choice = choices[issue.issueId] ?? { decision: "", why: "" };
              return (
                <div
                  key={issue.issueId}
                  className="flex flex-col gap-2 border-t border-line pt-3"
                  data-testid={`carried-${issue.displayId}`}
                >
                  <div className="flex items-baseline gap-2">
                    <MonoTag>{issue.displayId}</MonoTag>
                    <span className="fg-caption text-muted">at {issue.status}</span>
                  </div>
                  <RadioGroup
                    name={`carried-${issue.issueId}`}
                    value={choice.decision}
                    onChange={(v) => choose(issue.issueId, { decision: v as CarriedChoice["decision"] })}
                  >
                    {CHOICES.map((c) => (
                      <Radio key={c.value} value={c.value} label={c.label} />
                    ))}
                  </RadioGroup>
                  {choice.decision === "ship-unverified" && (
                    <Textarea
                      rows={2}
                      aria-label={`What is unverified in ${issue.displayId}`}
                      placeholder="What ships unverified, and why that is acceptable"
                      value={choice.why}
                      aria-invalid={choice.why.trim() === ""}
                      onChange={(e) => choose(issue.issueId, { why: e.target.value })}
                    />
                  )}
                </div>
              );
            })}
          </section>
        )}

        <div className="flex items-center gap-2 pt-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={batch.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            className="ml-auto"
            loading={batch.isPending}
            disabled={undecided > 0}
            title={
              undecided > 0
                ? `Decide ${undecided} carried issue${undecided === 1 ? "" : "s"} first — a Ship unverified decision needs its reason`
                : undefined
            }
            onClick={handleConfirm}
          >
            Release {selectedIssues.length > 0 ? `${selectedIssues.length} ` : ""}now
          </Button>
        </div>
      </div>
    </SlideOver>
  );
}
