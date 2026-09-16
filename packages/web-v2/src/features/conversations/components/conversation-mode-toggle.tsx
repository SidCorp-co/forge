"use client";

// What this conversation is talking to, picked by the person typing in it.
//
// The control belongs beside the composer and not in project settings: an
// operator does not choose, on somebody else's behalf, whether their question
// needs a checkout. It is live only while the room is empty — the first send
// writes the room's mode and this disappears — so there is no "change mode"
// affordance anywhere, by design. To talk to the other one, open another
// conversation (ISS-1039).

import type { AgentModeOffer, ConversationMode } from "../types";

/** What each mode is, in the words a person picking between them needs. */
// cm:guard each line says what the mode CAN REACH and not what it is called: "Agent" alone tells
// somebody choosing nothing, and the one difference they are choosing on is whether the answer can
// open a file in the repository.
const MODES: Array<{ mode: ConversationMode; label: string; hint: string }> = [
  {
    mode: "assistant",
    label: "Assistant",
    hint: "Reads this project — its issues, progress, knowledge and memory. No repository.",
  },
  {
    mode: "agent",
    label: "Agent",
    hint: "A session on a paired box with the repository checked out and a shell.",
  },
];

export function ConversationModeToggle({
  value,
  onChange,
  offer,
  disabled,
}: {
  value: ConversationMode;
  onChange: (mode: ConversationMode) => void;
  /** Whether Agent may be picked at all, and why not where it may not. */
  offer: AgentModeOffer;
  /** The whole control, while a send is in flight. */
  disabled?: boolean;
}) {
  // cm:guard Agent is offered DISABLED and labelled rather than hidden: a control that is not there
  // teaches a person the feature does not exist, and one that is there and greyed with its reason
  // beside it tells them what to do about it — pair a box. The reason is the server's own sentence
  // and is never composed here (ISS-1039).
  const agentBlocked = !offer.available;

  return (
    <div
      className="flex flex-wrap items-center gap-2 px-4 pt-3"
      role="radiogroup"
      aria-label="What this conversation talks to"
      data-testid="conversation-mode-toggle"
    >
      {MODES.map(({ mode, label, hint }) => {
        const blocked = mode === "agent" && agentBlocked;
        const selected = value === mode;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-describedby={blocked ? "conversation-mode-blocked" : undefined}
            disabled={disabled || blocked}
            title={blocked ? (offer.reason ?? undefined) : hint}
            onClick={() => onChange(mode)}
            className={[
              "rounded-full border px-3 py-1 text-sm transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
              selected
                ? "border-accent bg-accent-soft text-fg"
                : "border-line bg-surface text-muted hover:text-fg",
              blocked ? "cursor-not-allowed opacity-50 hover:text-muted" : "",
            ].join(" ")}
          >
            {label}
          </button>
        );
      })}
      {agentBlocked && offer.reason && (
        <p id="conversation-mode-blocked" className="fg-caption text-subtle">
          Agent unavailable — {offer.reason}.
        </p>
      )}
      {!agentBlocked && (
        <p className="fg-caption text-subtle">
          {MODES.find((m) => m.mode === value)?.hint}
        </p>
      )}
    </div>
  );
}
