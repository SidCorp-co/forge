"use client";

import Link from "next/link";
import { type ReactNode, useState } from "react";
import { ErrorState, ProjectLoader } from "@/design";
import { TONE_META } from "@/design/status";
import { requirementHref } from "@/features/requirements/routes";
import { formatApiError } from "@/lib/api/error";
import { formatRelativeTime } from "@/lib/utils/format";
import { useFeedbackItem } from "../hooks";
import { feedbackHref, issueHref } from "../routes";
import type { FeedbackPhase, FeedbackView } from "../types";
import { KindBadge, PhaseBadge, SeverityBadge, sentence } from "./badges";
import { FeedbackActions, Proposals } from "./feedback-actions";

const STRIP: FeedbackPhase[] = ["new", "triaged", "planned", "resolved", "verified"];

const TONE = {
  you: TONE_META.attention,
  moving: TONE_META.active,
  others: TONE_META.neutral,
  done: TONE_META.neutral,
} as const;

/** Where it stands: one tinted line saying who acts next, from the server's read model. */
function WhereItStands({ f }: { f: FeedbackView }) {
  const t = TONE[f.attention];
  return (
    <p
      className="flex items-baseline gap-2 px-3 py-2 text-13"
      style={{ color: t.fg, background: t.bg }}
      data-testid="feedback-waiting"
    >
      <span aria-hidden className="size-1.5 shrink-0 translate-y-[-1px] rounded-full" style={{ background: t.dot }} />
      <span>
        <span className="font-semibold">{f.attention === "done" ? "Done:" : "Waiting on:"}</span> {f.waitingOn}
      </span>
    </p>
  );
}

function PhaseStrip({ phase }: { phase: FeedbackPhase }) {
  const at = STRIP.indexOf(phase);
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-12" aria-label="Lifecycle">
      {STRIP.map((p, i) => {
        const reached = at >= 0 && i <= at;
        return (
          <li key={p} className="flex items-center gap-2">
            {i > 0 ? <span aria-hidden className="h-px w-5 bg-line" /> : null}
            <span className={reached ? "font-semibold text-fg" : "text-subtle"} aria-current={i === at ? "step" : undefined}>
              {sentence(p)}
            </span>
          </li>
        );
      })}
      {at < 0 ? (
        <li className="ml-2">
          <PhaseBadge phase={phase} />
        </li>
      ) : null}
    </ol>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 border-b border-line py-2 text-13 last:border-b-0">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function TargetLink({ f, slug }: { f: FeedbackView; slug: string }) {
  const t = f.target;
  const key =
    t.type === "requirement" ? (
      <Link className="font-mono text-accent hover:underline" href={requirementHref(slug, t.key)}>
        {t.key}
      </Link>
    ) : t.type === "issue" ? (
      <Link className="font-mono text-accent hover:underline" href={issueHref(slug, t.key)}>
        {t.key}
      </Link>
    ) : t.type === "screen" ? (
      <span>“{t.key}”</span>
    ) : (
      <span className="font-mono">{t.key}</span>
    );
  return (
    <span>
      {sentence(t.type)} {key}
      {t.title ? <span className="text-muted"> · {t.title}</span> : null}
    </span>
  );
}

function RouteFact({ f, slug }: { f: FeedbackView; slug: string }) {
  const r = f.route;
  if (!r) return <span className="text-subtle">Not routed yet</span>;
  const carrier =
    r.route === "issue" && r.key ? (
      <Link className="font-mono text-accent hover:underline" href={issueHref(slug, r.key)}>
        {r.key}
      </Link>
    ) : r.route === "new_requirement" && r.key ? (
      <Link className="font-mono text-accent hover:underline" href={requirementHref(slug, r.key)}>
        {r.key}
      </Link>
    ) : r.route === "duplicate" && r.key ? (
      <Link className="font-mono text-accent hover:underline" href={feedbackHref(slug, r.key)}>
        {r.key}
      </Link>
    ) : null;
  return (
    <span className="grid gap-1">
      <span>
        {sentence(r.route)} {carrier}
        {r.status ? <span className="text-muted"> · {sentence(r.status)}</span> : null}
      </span>
      {r.answer ? <span className="whitespace-pre-wrap text-muted">{r.answer}</span> : null}
    </span>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-2">
      <h3 className="text-12 font-semibold text-muted">{title}</h3>
      {children}
    </section>
  );
}

function History({ f }: { f: FeedbackView }) {
  if (f.decisions.length === 0) return <p className="text-13 text-subtle">No decision yet.</p>;
  return (
    <ol className="grid gap-2" data-testid="feedback-history">
      {[...f.decisions].reverse().map((d) => (
        <li key={`${d.decidedAt}-${d.decision}`} className="grid gap-0.5 text-13">
          <span>
            <span className="font-semibold">{sentence(d.decision)}</span>
            {d.route ? ` as ${sentence(d.route).toLowerCase()}` : ""}
            {d.carrier ? <span className="font-mono"> {d.carrier}</span> : null}
            <span className="text-muted">
              {" "}
              · {d.decidedByName ?? d.decidedBy}
              {d.decidedAgency === "agent" ? " (agent)" : ""} ·{" "}
              <span title={new Date(d.decidedAt).toLocaleString()}>{formatRelativeTime(d.decidedAt)}</span>
            </span>
          </span>
          {d.reason ? <span className="text-muted">{d.reason}</span> : null}
        </li>
      ))}
    </ol>
  );
}

function Body({ f }: { f: FeedbackView }) {
  return (
    <Section title="What the reporter said">
      {f.redacted ? (
        <p className="text-13 text-subtle">The reporter’s data was deleted; the item stays so its links resolve.</p>
      ) : (
        <p className="whitespace-pre-wrap text-14" data-testid="feedback-body">
          {f.body?.trim() ? f.body : <span className="text-subtle">No description.</span>}
        </p>
      )}
      {f.attachments.length > 0 ? (
        <ul className="grid gap-1 text-13">
          {f.attachments.map((a) => (
            <li key={a.id} className="flex items-center gap-2">
              <span className="font-mono">{a.name}</span>
              <span className="text-subtle">{Math.ceil(a.size / 1024)} KB</span>
              {a.flagged ? (
                <span
                  className="text-11 font-semibold"
                  style={{ color: TONE_META.attention.fg }}
                  title="On a sensitive project an attachment may hold personal data; it never reaches a provider"
                >
                  Flagged
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}

export function FeedbackDetailView({
  projectId,
  slug,
  fbKey,
  full,
  head,
}: {
  projectId: string;
  slug: string;
  fbKey: string;
  full: boolean;
  head?: ReactNode;
}) {
  const q = useFeedbackItem(projectId, fbKey);
  const [showHistory, setShowHistory] = useState(full);
  if (q.isLoading) return <ProjectLoader label="loading feedback…" />;
  if (q.isError || !q.data) return <ErrorState message={formatApiError(q.error)} onRetry={() => q.refetch()} />;
  const f = q.data.feedback;
  return (
    <article className="grid content-start gap-4" data-testid="feedback-detail" data-key={f.key}>
      <header className="grid gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-12 text-accent">{f.key}</span>
          <PhaseBadge phase={f.phase} />
          <SeverityBadge severity={f.severity} />
          <span className="ml-auto flex items-center gap-2">{head}</span>
        </div>
        <h2 className="text-16 font-semibold leading-snug">{f.title}</h2>
      </header>
      <WhereItStands f={f} />
      <PhaseStrip phase={f.phase} />
      <dl className="grid">
        <Fact label="Reporter">
          {f.reporter.name ?? f.reporter.id}
          {f.reporter.agency === "agent" ? <span className="text-muted"> · agent</span> : null}
          <span className="text-muted" title={new Date(f.createdAt).toLocaleString()}>
            {" "}
            · {formatRelativeTime(f.createdAt)}
          </span>
        </Fact>
        <Fact label="About">
          <TargetLink f={f} slug={slug} />
        </Fact>
        <Fact label="Kind">
          <KindBadge kind={f.kind} />
        </Fact>
        <Fact label="Route">
          <RouteFact f={f} slug={slug} />
        </Fact>
        {f.duplicates.length > 0 ? (
          <Fact label="Duplicates">
            {f.duplicates.map((k) => (
              <Link key={k} className="mr-2 font-mono text-accent hover:underline" href={feedbackHref(slug, k)}>
                {k}
              </Link>
            ))}
          </Fact>
        ) : null}
        {f.whereSeen && f.target.type !== "screen" ? <Fact label="Where seen">{f.whereSeen}</Fact> : null}
        {f.clarification ? (
          <Fact label="Clarification">
            <span title={f.clarification.prompt ?? undefined}>
              {sentence(f.clarification.status)}
              {f.clarification.answer ? <span className="text-muted"> · {f.clarification.answer}</span> : null}
            </span>
          </Fact>
        ) : null}
        {f.sensitive ? (
          <Fact label="Data">
            <span title="This project's data policy scrubs feedback text on write; attachments are flagged">
              Sensitive project · text scrubbed on write
            </span>
          </Fact>
        ) : null}
      </dl>
      <Proposals projectId={projectId} f={f} />
      <FeedbackActions projectId={projectId} f={f} />
      <Body f={f} />
      <Section title={`History ${f.decisions.length}`}>
        {showHistory ? (
          <History f={f} />
        ) : (
          <button type="button" className="w-fit text-12 font-semibold text-accent hover:underline" onClick={() => setShowHistory(true)}>
            Show history
          </button>
        )}
      </Section>
    </article>
  );
}
