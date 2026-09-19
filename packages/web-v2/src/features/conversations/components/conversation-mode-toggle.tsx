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
  const agentBlocked = !offer.available;

  return (
    <fieldset
      className="flex flex-wrap items-center gap-2 border-0 px-4 pt-3"
      data-testid="conversation-mode-toggle"
    >
      <legend className="sr-only">What this conversation talks to</legend>
      {MODES.map(({ mode, label, hint }) => {
        const blocked = mode === "agent" && agentBlocked;
        const selected = value === mode;
        return (
          <label
            key={mode}
            title={blocked ? (offer.reason ?? undefined) : hint}
            className={[
              "rounded-full border px-3 py-1 text-sm transition-colors",
              "focus-within:outline-none focus-within:ring-2 focus-within:ring-accent",
              selected
                ? "border-accent bg-accent-soft text-fg"
                : "border-line bg-surface text-muted hover:text-fg",
              blocked ? "cursor-not-allowed opacity-50 hover:text-muted" : "cursor-pointer",
            ].join(" ")}
          >
            <input
              type="radio"
              name="conversation-mode"
              className="sr-only"
              value={mode}
              checked={selected}
              disabled={disabled || blocked}
              aria-describedby={blocked ? "conversation-mode-blocked" : undefined}
              onChange={() => onChange(mode)}
            />
            {label}
          </label>
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
    </fieldset>
  );
}
