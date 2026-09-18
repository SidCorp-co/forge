"use client";

// The one line saying what a turn is doing right now (ISS-1083).
//
// Before this, a turn had no way to say anything about itself: `AgentTurn` renders `item.blocks`
// and nothing else, and `parseMessages` drops an entry carrying none — so a turn that was running
// and had emitted nothing showed the sent bubble and then empty space. The stage is a fact about
// the RUN and not a block in the transcript, which is why it is drawn beside the blocks and never
// among them: synthesizing a block for it would file a claim no producer emitted, the same defect
// ISS-1079 refused when it declined to invent thinking blocks on the Claude Code path.
//
// What this REPLACES, on both surfaces: `AgentWorking` — the mascot card reading "Agent is
// working…". On the session screen it was drawn under every live turn, saying the turn had produced
// nothing directly beneath the words it had produced; in the chat panel it was silenced the moment
// frames arrived, so the rest of the turn said nothing at all. Neither call site survives this
// change. The kit pattern itself stays in the gallery, unused by any surface, as `ReconnectingBanner`
// already is.
//
// Kit-only: imports from @/design, semantic tokens, no hex.
import { Icon, Spinner } from "@/design";
import type { AgentSessionDisplayStatus } from "@/features/sessions/types";
import type { ConversationItem, RenderBlock } from "../types";

/**
 * What a turn is doing, where it is doing anything.
 */
// cm:guard there is no `settled` member, and its absence IS the settled state. A line saying "Done"
// cannot survive a reload — the stage is nowhere on the stored row — so a turn would read one way
// while you watched it finish and another way after a refresh, which is the inconsistency this
// shape refuses. `failed` is the one that persists, because success is evident from the answer and
// failure is evident from nothing at all.
export type TurnStage = "working" | "responding" | "failed";

const LABEL: Record<TurnStage, string> = {
  working: "Working…",
  responding: "Responding…",
  failed: "Failed",
};

/**
 * The stage a turn is in, or nothing at all where the turn is not doing anything.
 */
// cm:guard ONE rule with two callers, because each of them holds only half of what it takes to
// answer: whether the run is live or failed is a fact about the session or the socket, which the
// surface holds, and working-versus-responding is read off the transcript's tail, which the renderer
// holds. Deriving it in each surface is how the full-page session screen and the chat dock start
// disagreeing about what the same turn is doing — the defect ISS-1083's plan decision 1 named when
// it moved the assistant column's measure into one place for the same reason.
//
// cm:why `failed` outranks `live`: a session whose status went failed may still look live for as
// long as its heartbeat takes to lapse, and a spinner over a turn that has already died is the
// working line "left running" that criterion 19 refuses by name.
export function turnStageOf({
  live,
  failed,
  blocks,
}: {
  /** The run is producing this turn right now. */
  live?: boolean;
  /** The run this turn belongs to failed. */
  failed?: boolean;
  /** The live turn's render blocks, in order — the tail decides which live stage it is. */
  blocks?: readonly RenderBlock[] | undefined;
}): TurnStage | null {
  if (failed === true) return "failed";
  if (live !== true) return null;
  // cm:guard the TAIL and never "has this turn produced any text": a turn that wrote a sentence and
  // then called a tool is working, and the other reading leaves it saying "Responding…" for the
  // whole of a five-minute call.
  return blocks?.[blocks.length - 1]?.type === "text" ? "responding" : "working";
}

/**
 * The stage a runner session's newest turn is in, off the facts the session screen already holds.
 */
// cm:guard this exists so the SESSION screen's reading of its own status is a rule a test can hold:
// which statuses mean failed, and what a transcript with no turn rows under it may say. Inline in
// that screen's JSX it was three judgements nothing could go red on, and criterion 19 is exactly one
// of them.
//
// cm:guard `failed` is the ONLY status that draws a stage on a settled session. `cancelled` and
// `cancelled_stale` are not failures — a person stopped the work, or the stale-sweep cleaned it up,
// and a red line over either is state that lies (`VISION: state-never-lies`; the same demotion
// `features/sessions/types.ts:statusToChip` makes for the chip). `stalled` never reaches here as a
// failure either: it is a LIVE session whose heartbeat is overdue and which the sweeper is about to
// recover, so the screen's own `live` covers it and the spinner is telling the truth.
//
// cm:guard `fromMessages` withholds the BLOCKS and never the stage itself, so a live session on that
// path always reads `Working…`. Where the transcript comes from `agent_sessions.messages` rather
// than turn rows there is nothing growing to read a tail off, and calling it `Responding…` would
// claim prose was streaming that this screen cannot watch arrive — but the session IS running, and
// suppressing the line on that ground loses the indicator the `AgentWorking` card showed throughout
// (implementation consult F1). Where the transcript came from is a fact about storage; whether the
// run is working is not.
export function sessionTurnStage({
  live,
  display,
  fromMessages,
  tail,
}: {
  /** The screen's own liveness, so which statuses are live is stated in one place and not two. */
  live: boolean;
  display: AgentSessionDisplayStatus;
  /** The transcript came from `agent_sessions.messages` rather than from turn rows (ISS-348). */
  fromMessages?: boolean;
  /** The thread's last item, whichever kind it is. */
  tail?: Pick<ConversationItem, "kind" | "blocks"> | undefined;
}): TurnStage | null {
  return turnStageOf({
    live,
    failed: display === "failed",
    ...(fromMessages !== true && tail?.kind === "agent" ? { blocks: tail.blocks } : {}),
  });
}

/**
 * One line, one position, for the whole turn.
 */
// cm:guard the element is the SAME in every stage and only its content changes, so the line cannot
// appear, move or vanish while a reader is looking at the turn under it. That is why `working` and
// `responding` are one component and not two, and why the icon slot is a fixed 14px whether it
// holds a spinner or a glyph. `turn-stage.test.tsx` asserts it as node identity across a rerender,
// which is the only form of that property a test can hold.
export function TurnStage({ stage, elapsed }: { stage: TurnStage; elapsed?: string }) {
  return (
    <div
      data-testid="turn-stage"
      data-stage={stage}
      className="flex items-center gap-1.5 text-subtle"
      style={{ fontSize: 12 }}
      aria-live="polite"
    >
      <span className="flex h-[14px] w-[14px] flex-none items-center justify-center">
        {stage === "failed" ? (
          <Icon name="alert" size={12} className="text-danger" />
        ) : (
          <Spinner size={12} />
        )}
      </span>
      <span>{LABEL[stage]}</span>
      {/* cm:why the clock sits in the flow rather than pushed to the far edge with `ml-auto`, which
          is where the card this replaced kept it: on a 900px dock that put it a panel's width away
          from the words it belongs to. */}
      {elapsed && <span className="font-mono">· {elapsed}</span>}
    </div>
  );
}
