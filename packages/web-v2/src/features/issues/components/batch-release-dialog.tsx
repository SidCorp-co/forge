"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Banner, Button, MonoTag, Radio, RadioGroup, SlideOver, Textarea } from "@/design";
import { inlineCode } from "@/features/project-settings/components/inline-code";
import { ApiError } from "@/lib/api/client";
import { formatApiError } from "@/lib/api/error";
import type { CarriedDecisionBody } from "../api";
import { STATUS_LABELS } from "../derive";
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
  title: string;
  status: string;
}

type CarriedChoice = { decision: CarriedDecisionBody["decision"] | ""; why: string };

/** Each choice with what it does, said before a person picks one (ISS-1386 r2). */
const CHOICES: Array<{ value: CarriedDecisionBody["decision"]; label: string; explains: string }> = [
  {
    value: "ship-unverified",
    label: "Ship unverified",
    explains: "It ships as it is, with this release. Say what is unverified; that is written on the issue.",
  },
  {
    value: "revert",
    label: "Reverted",
    explains: "Its work is taken back out. Only holds once a revert of it is already on the branch being released.",
  },
  {
    value: "cut-below",
    label: "Cut below",
    explains: "The release stops just before it, so it also leaves out every landing above it.",
  },
];

/** The refusal and every reason riding behind it, each as its code and details. */
function refusalsIn(err: unknown): Array<{ code: string; details: Record<string, unknown> }> {
  if (!(err instanceof ApiError) || !err.code) return [];
  const head = (err.details ?? {}) as Record<string, unknown>;
  const rest = Array.isArray(head.alsoBlocking) ? (head.alsoBlocking as unknown[]) : [];
  return [
    { code: err.code, details: head },
    ...rest.flatMap((b) => {
      const r = b as { code?: unknown; details?: unknown };
      return typeof r?.code === "string" ? [{ code: r.code, details: (r.details ?? {}) as Record<string, unknown> }] : [];
    }),
  ];
}

/** The carried issues a refusal names, read off its details rather than out of its prose. */
function carriedIn(err: unknown): CarriedIssue[] | null {
  const found = refusalsIn(err).find((r) => r.code === "RELEASE_CARRIES_UNDECIDED");
  const listed = found?.details.carried;
  if (!Array.isArray(listed)) return null;
  return listed.flatMap((i) =>
    i && typeof i.issueId === "string" && typeof i.displayId === "string"
      ? [
          {
            issueId: i.issueId,
            displayId: i.displayId,
            title: typeof i.title === "string" ? i.title : "",
            status: String(i.status ?? ""),
          },
        ]
      : [],
  );
}

/** Why the server refused each decision it refused, by issue id. */
function refusedIn(err: unknown): Record<string, string> {
  const found = refusalsIn(err).find((r) => r.code === "RELEASE_CARRIED_DECISION_REFUSED");
  const listed = found?.details.refused;
  if (!Array.isArray(listed)) return {};
  return Object.fromEntries(
    listed.flatMap((r) => (r && typeof r.issueId === "string" ? [[r.issueId, String(r.why ?? "")]] : [])),
  );
}

/** The banner's words: a carried refusal is said in the person's terms, the rows carrying the rest. */
function refusalMessage(err: unknown): string {
  const head = err instanceof ApiError ? err.code : null;
  if (head === "RELEASE_CARRIES_UNDECIDED") {
    const n = carriedIn(err)?.length ?? 0;
    return `This release would also ship ${n === 1 ? "an issue" : `${n} issues`} nobody put on it. Decide each one above, then press Release again.`;
  }
  if (head === "RELEASE_CARRIED_DECISION_REFUSED") {
    const n = Object.keys(refusedIn(err)).length;
    return `${n === 1 ? "A decision" : `${n} decisions`} did not hold; each is marked above with why. Change it and press Release again.`;
  }
  return formatApiError(err);
}

function statusLabel(status: string): string {
  return (STATUS_LABELS as Record<string, string>)[status] ?? status;
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
  const [refusedWhy, setRefusedWhy] = useState<Record<string, string>>({});
  const bannerRef = useRef<HTMLDivElement | null>(null);

  // A refusal belongs to the press that met it, so a dialog opened again starts clean; a press
  // still in flight is kept, since resetting it would leave its answer nowhere to land.
  const pendingRef = useRef(isPending);
  pendingRef.current = isPending;
  useEffect(() => {
    if (!open) return;
    setRefusal(null);
    setCarried([]);
    setChoices({});
    setRefusedWhy({});
    if (!pendingRef.current) reset();
  }, [open, reset]);

  // Each refusal is brought into view: the person is at the Release button, not the top (ISS-1386 r2).
  const tries = refusal?.tries ?? 0;
  useEffect(() => {
    if (tries > 0) bannerRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [tries]);

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
          // A refusal names only what is still undecided, so the decisions already made are kept.
          if (named) setCarried((prev) => [...prev, ...named.filter((n) => !prev.some((p) => p.issueId === n.issueId))]);
          setRefusedWhy(refusedIn(err));
          setRefusal((prev) => ({ message: refusalMessage(err), tries: (prev?.tries ?? 0) + 1 }));
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
          be released together and closed in one batch. This cannot be undone.
        </p>

        <ul className="flex flex-col divide-y divide-line border-y border-line">
          {selectedIssues.map((issue) => (
            <li key={issue.id} className="fg-body-sm flex min-w-0 items-baseline gap-2 py-1.5">
              <span className="font-mono text-xs font-semibold text-fg shrink-0">{issue.displayId}</span>
              <span className="min-w-0 truncate text-muted">{issue.title}</span>
            </li>
          ))}
        </ul>

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
                  <div className="flex min-w-0 items-baseline gap-2">
                    <MonoTag>{issue.displayId}</MonoTag>
                    <span className="fg-body-sm min-w-0 truncate text-fg">{issue.title}</span>
                    <span className="fg-caption ml-auto shrink-0 text-muted">{statusLabel(issue.status)}</span>
                  </div>
                  {refusedWhy[issue.issueId] ? (
                    <p className="fg-caption text-danger">Refused: {refusedWhy[issue.issueId]}</p>
                  ) : null}
                  <RadioGroup
                    name={`carried-${issue.issueId}`}
                    value={choice.decision}
                    onChange={(v) => choose(issue.issueId, { decision: v as CarriedChoice["decision"] })}
                  >
                    {CHOICES.map((c) => (
                      <Radio
                        key={c.value}
                        value={c.value}
                        label={
                          <span className="flex flex-col">
                            <span>{c.label}</span>
                            <span className="fg-caption text-muted">{c.explains}</span>
                          </span>
                        }
                      />
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

        {/* A toast paints beneath this drawer's scrim, so the refusal is said here and only here. */}
        {refusal && (
          <div role="alert" ref={bannerRef}>
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
