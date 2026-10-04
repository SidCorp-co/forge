"use client";

import { RELEASE_STATE_LABELS } from "@forge/contracts/releases";
import { useState } from "react";
import { type BannerTone, Icon, LEGEND, Tooltip, WaitBanner, type WaitingOnView } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { ApiError } from "@/lib/api/client";
import type { ReleaseAttention, ReleaseDetail, ReleaseGateView, ReleaseWaiting } from "../types";

export const waitingView = (w: ReleaseWaiting): WaitingOnView => ({
  kind: w.kind,
  who: w.who,
  act: w.act,
  ...(w.rule ? { rule: w.rule } : {}),
});

const BANNER_TONE: Record<ReleaseAttention, BannerTone> = {
  you: "you",
  moving: "run",
  others: "calm",
  stuck: "err",
  done: "calm",
  stopped: "calm",
};

export const shortSha = (sha: string) => sha.slice(0, 7);

const NAMED_IN_SENTENCE = 5;

export function GateLine({ gate }: { gate: ReleaseGateView }) {
  const [open, setOpen] = useState(false);
  const more = gate.issues.length > NAMED_IN_SENTENCE;
  return (
    <li className="flex items-start gap-2 py-2 text-13" data-testid="release-gate" data-code={gate.code}>
      <span
        aria-hidden
        className="mt-[7px] size-1.5 flex-none rounded-full"
        style={{ background: gate.kind === "blocker" ? LEGEND.err.dot : LEGEND.you.dot }}
      />
      <span className="min-w-0 flex-1">
        <b className="font-semibold">{gate.title}.</b> {gate.sentence}
        {more ? (
          <>
            {" "}
            <button
              type="button"
              className="inline-flex items-center gap-1 text-12-5 font-medium text-link"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              data-testid="gate-issues-toggle"
            >
              <Icon name="chevronDown" size={12} className={open ? "" : "-rotate-90"} />
              {open ? "Hide the issues" : `All ${gate.issues.length} issues`}
            </button>
            {open ? (
              <span className="mt-1 block font-mono text-12 text-muted" data-testid="gate-issues">
                {gate.issues.join(", ")}
              </span>
            ) : null}
          </>
        ) : null}
      </span>
      <Tooltip label={`${gate.code} · ${gate.detail}`} multiline>
        <span className="mt-0.5 text-subtle" role="img" aria-label={`Details of ${gate.title}`}>
          <Icon name="info" size={14} />
        </span>
      </Tooltip>
    </li>
  );
}

export function ReleaseBanner({ r, className }: { r: ReleaseDetail; className?: string }) {
  const w = r.waiting;
  const ended = r.attention === "done" || r.attention === "stopped";
  const stuck = r.attention === "stuck";
  const head = ended
    ? `${RELEASE_STATE_LABELS[r.state]}.`
    : stuck
      ? "Stuck:"
      : `Waiting on ${w.kind === "you" ? "you" : w.who}:`;
  const body = ended
    ? r.state === "shipped"
      ? r.current
        ? "Live on production."
        : "Superseded by a later release."
      : "Nothing is owed on it."
    : stuck
      ? `${w.who}: ${w.act}`
      : w.act;
  return <WaitBanner tone={BANNER_TONE[r.attention]} head={head} body={body} rule={w.rule || undefined} className={className} />;
}

export function RefusalText({ error }: { error: unknown }) {
  if (!error) return null;
  const code = error instanceof ApiError ? error.code : null;
  return (
    <p role="alert" className="text-12" style={{ color: "var(--red-600)" }} title={code ?? undefined} data-testid="release-refusal">
      {formatApiError(error)}
    </p>
  );
}
