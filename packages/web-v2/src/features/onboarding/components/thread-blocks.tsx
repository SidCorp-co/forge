"use client";

// The structured messages a thread can hold beside prose (ISS-63): a questionnaire card, a
// person's answers, and a list of designs with their live status. Every one of them reads its state
// from the thread's own data (the batches on the conversation detail, the designs on the onboarding
// read), never from the message, so a card says what is true now.

import { createContext, type ReactNode, useContext, useMemo } from "react";
import Link from "next/link";
import { Markdown } from "@/design/patterns/markdown";
import { useOnboardingState } from "../hooks";
import { useAskForDesigns } from "./ask-for-designs";
import type { OnboardingDesignView, QuestionnaireView } from "../types";
import { DesignStatusChip, HoverNote, ToneChip } from "./marks";
import { QuestionnaireCard, QuestionnaireSummary } from "./questionnaire-card";

export interface ThreadBlock {
  type: string;
  text?: string;
  batchId?: string;
  designs?: { heading: string; workflowIds: string[]; approve?: boolean };
}

interface ThreadData {
  projectId: string;
  /** The project's slug, for links out of the thread; undefined until the project list loads. */
  projectSlug: string | undefined;
  conversationId: string;
  kind: "onboarding" | "requirement" | "first_requirements" | null;
  questionnaires: QuestionnaireView[];
}

const ThreadDataContext = createContext<ThreadData | null>(null);

export function ThreadDataProvider({ value, children }: { value: ThreadData; children: ReactNode }) {
  return <ThreadDataContext.Provider value={value}>{children}</ThreadDataContext.Provider>;
}

const STRUCTURED = new Set(["questionnaire", "questionnaire_answers", "designs"]);

/** Whether a stored message is one of the structured kinds this module draws. */
export function isStructured(blocks: readonly { type: string }[] | null | undefined): boolean {
  return Boolean(blocks?.some((b) => STRUCTURED.has(b.type)));
}

function spoken(iso: string) {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? { label: "", title: iso }
    : { label: at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }), title: at.toLocaleString() };
}

/** One message in the prototype's frame: an avatar, who, when, and the body. A wide one gives the card the full width. */
export function ThreadMessage({
  who,
  name,
  at,
  wide,
  children,
}: {
  who: "agent" | "me";
  name: string;
  at: string;
  wide?: boolean;
  children: ReactNode;
}) {
  const when = spoken(at);
  const avatar = (
    <span
      aria-hidden
      className={`grid size-[22px] flex-none place-items-center rounded-full text-[10px] font-bold ${
        who === "me" ? "bg-[color:var(--amberw-500)] text-white" : "bg-[color:var(--ai-bg)] text-[color:var(--ai-fg)]"
      }`}
    >
      {who === "me" ? "Y" : name.startsWith("BA") ? "B" : "A"}
    </span>
  );
  const header = (
    <div className="flex flex-wrap items-baseline gap-2">
      {wide && avatar}
      <span className={`font-semibold ${who === "agent" ? "text-[color:var(--ai-fg)]" : "text-fg"}`}>{name}</span>
      {when.label && (
        <time dateTime={at} title={when.title} className="font-mono text-[10.5px] text-subtle">
          {when.label}
        </time>
      )}
    </div>
  );
  return (
    <div className={`grid items-start gap-2 text-[12.5px] ${wide ? "grid-cols-1" : "grid-cols-[22px_minmax(0,1fr)]"}`}>
      {!wide && avatar}
      <div className="min-w-0">
        {header}
        {children}
      </div>
    </div>
  );
}

function useDesigns(projectId: string, enabled: boolean) {
  const q = useOnboardingState(enabled ? projectId : undefined);
  return useMemo(() => {
    const m = new Map<string, OnboardingDesignView>();
    for (const d of q.data?.onboarding?.designs ?? []) m.set(d.workflowId, d);
    return { byId: m, onboarding: q.data?.onboarding ?? null };
  }, [q.data]);
}

// The items that shaped a design and, once every round is sent, its open questions: both read by
// core from the item records (designs, what-next).
function LinkedItemsNote({ design }: { design: OnboardingDesignView }) {
  const open = design.openQuestions.length;
  return (
    <HoverNote
      className="flex-none text-[11.5px] text-subtle"
      label={open ? `${design.linkedItems.length} items · ${open} open` : `${design.linkedItems.length} items`}
    >
      <span className="flex flex-col gap-0.5">
        {design.linkedItems.map((i) => (
          <span key={i.questionId}>
            {i.prompt} · {i.state}
            {i.citedRevision !== null ? ` · rev ${i.citedRevision}` : ""}
          </span>
        ))}
        {open > 0 && <span>Open questions stay on the design; no fourth round is asked.</span>}
      </span>
    </HoverNote>
  );
}

function DesignsBlock({ block, first }: { block: NonNullable<ThreadBlock["designs"]>; first: boolean }) {
  const data = useContext(ThreadDataContext);
  const projectId = data?.projectId ?? "";
  const slug = data?.projectSlug;
  const { byId, onboarding } = useDesigns(projectId, data?.kind === "onboarding");
  const reanalyze = useAskForDesigns(projectId, data?.conversationId ? { conversationId: data.conversationId } : {});
  const rows = block.workflowIds.map((id) => ({ id, design: byId.get(id) }));
  return (
    <div className="my-1" data-testid="designs-block">
      {/* the analysis's list reads as a labelled count, as the prototype draws it; every later list is the message's own heading */}
      <div className={first ? "py-1.5 text-[11.5px] text-subtle" : "mb-1 font-bold text-fg"}>
        {block.heading}
        {first && ` ${rows.length}`}
      </div>
      <div className="flex w-full flex-col">
        {rows.map(({ id, design }) => {
          const href = slug && design ? `/projects/${slug}/workflows/${encodeURIComponent(design.flow)}` : undefined;
          return (
            <div key={id} className="flex min-w-0 items-center gap-1.5 border-b border-line-subtle py-1 last:border-b-0">
              {href ? (
                <Link
                  href={href}
                  className="min-w-0 flex-1 truncate font-semibold text-link hover:underline"
                  title={design ? `${design.template ?? "design"} · rev ${design.revision}` : id}
                >
                  {design?.title ?? id}
                </Link>
              ) : (
                <span className="min-w-0 flex-1 truncate font-semibold text-muted">{design?.title ?? id}</span>
              )}
              <ToneChip tone="neutral" glyph="⌂" label="Plan from code" title="The plan, drawn from the code: it holds no evidence, and nothing is observed while it is proposed" />
              {design && design.linkedItems.length > 0 && <LinkedItemsNote design={design} />}
              <DesignStatusChip status={design?.designStatus ?? null} />
              {block.approve && href && design?.designStatus === "proposed" && (
                <Link
                  href={`${href}?focus=approve`}
                  className="ml-1 inline-flex h-7 flex-none items-center rounded-md border border-line bg-surface px-2.5 text-[12px] font-semibold text-fg hover:bg-hover"
                >
                  Approve
                </Link>
              )}
            </div>
          );
        })}
      </div>
      {first && data?.kind === "onboarding" && onboarding && (
        <div className="mt-1 grid grid-cols-[84px_minmax(0,1fr)] items-start gap-x-2.5 border-t border-line-subtle py-1.5">
          <span className="pt-px text-[11.5px] text-subtle">Analysis</span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <HoverNote label={`Job ${onboarding.job?.status ?? "none"}`}>
              Cost bound: one analysis job per onboarding. A re-analysis runs only when a person asks.
            </HoverNote>
            <HoverNote
              label={
                <button
                  type="button"
                  className="text-[12px] font-semibold text-link no-underline hover:underline disabled:opacity-60"
                  disabled={reanalyze.pending}
                  onClick={() => reanalyze.ask("reanalyze")}
                >
                  Re-analyze
                </button>
              }
            >
              Runs one new analysis job and replaces any open batch. Refused while a job runs (ONBOARDING_ALREADY_RUNNING).
              Approved revisions are never overwritten.
            </HoverNote>
            {reanalyze.dialog}
          </span>
        </div>
      )}
    </div>
  );
}

/** A stored message holding a structured block, drawn in the prototype's frame. */
export function StructuredMessage({
  message,
  firstDesigns,
}: {
  message: { id: string; role: string; authorLabel: string | null; createdAt: string; blocks?: readonly ThreadBlock[] | null };
  firstDesigns: boolean;
}) {
  const data = useContext(ThreadDataContext);
  const blocks = message.blocks ?? [];
  const batchOf = (id?: string) => data?.questionnaires.find((q) => q.id === id);
  const { byId } = useDesigns(data?.projectId ?? "", data?.kind === "onboarding");
  const designTitle = (ref: string) => byId.get(ref)?.title ?? ref;
  const name = message.authorLabel ?? (data?.kind === "requirement" || data?.kind === "first_requirements" ? "BA assistant" : "Agent");
  const answers = blocks.find((b) => b.type === "questionnaire_answers");
  if (message.role === "user" && answers) {
    const batch = batchOf(answers.batchId);
    return (
      <ThreadMessage who="me" name="You" at={message.createdAt}>
        {batch ? <QuestionnaireSummary batch={batch} /> : <p className="text-muted">Answers sent.</p>}
      </ThreadMessage>
    );
  }
  const card = blocks.find((b) => b.type === "questionnaire");
  if (card) {
    const batch = batchOf(card.batchId);
    if (!batch) return null;
    // once sent, the card collapses into the person's answers message, as the prototype draws it
    if (batch.status === "submitted") return null;
    if (batch.status === "superseded") {
      return (
        <ThreadMessage who="agent" name={name} at={message.createdAt}>
          <p className="my-[3px] text-muted">
            {batch.title} · Round {batch.round} · superseded by a re-analysis
          </p>
        </ThreadMessage>
      );
    }
    return (
      <ThreadMessage who="agent" name={name} at={message.createdAt} wide>
        {batch.intro && <p className="my-[3px] mb-1.5">{batch.intro}</p>}
        <QuestionnaireCard projectId={data?.projectId ?? ""} batch={batch} designTitle={designTitle} />
      </ThreadMessage>
    );
  }
  return (
    <ThreadMessage who="agent" name={name} at={message.createdAt}>
      {blocks.map((b, i) => {
        const key = `${b.type}-${i}`;
        if (b.type === "text" && b.text)
          return (
            <div key={key} className="my-[3px] [&_p]:my-[3px] [&_p]:mb-1.5 [&_p]:text-[12.5px]! [&_p]:leading-[1.55]! [&_p]:text-fg!">
              <Markdown>{b.text}</Markdown>
            </div>
          );
        if (b.type === "designs" && b.designs) return <DesignsBlock key={key} block={b.designs} first={firstDesigns} />;
        return null;
      })}
    </ThreadMessage>
  );
}
