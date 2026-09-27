"use client";

// What this conversation is talking to, picked by the person typing in it.
//
// It lives in the composer's footer row rather than in a band of its own,
// because a control belongs on the same column as the thing it controls. It is
// live only while the room is empty — the first send writes the room's mode and
// there is no changing it afterwards (ISS-1039) — so once that is settled this
// becomes a label, which is the one thing the band it replaces never did.
//
// The markup is a radiogroup and stays one: `fieldset` + `legend.sr-only` +
// `input[type=radio]`, one tab stop with the arrows moving between options.

import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { Icon } from "@/design";
import { ComposerWidthContext } from "@/features/chat/components/chat-composer";
import type { AgentModeOffer, ConversationMode } from "../types";

/**
 * The composer width below which both modes will not sit side by side without
 * crowding the attach button and the send button off their own row. Measured
 * on the pane, not the window: the dock is 420px inside a 1440px one.
 */
const TRACK_MIN_WIDTH = 480;

/**
 * Where a pairing starts. `/pair` is only the approval half and, reached with
 * no code, tells the person to go and run the CLI.
 */
export const PAIR_A_RUNNER = "/runners";

interface ModeMeta {
  mode: ConversationMode;
  label: string;
  hint: string;
}

/** What each mode is, in the words a person picking between them needs. */
export const MODES: ModeMeta[] = [
  {
    mode: "assistant",
    label: "Assistant",
    hint: "Reads this project — its issues, progress, knowledge and memory. No repository.",
  },
  {
    mode: "agent",
    label: "Agent",
    hint: "A session on a paired runner with the repository checked out and a shell.",
  },
];

/** The box's own placeholder, so the mode is readable while typing too. */
export function modePlaceholder(mode: ConversationMode | null): string {
  if (mode === "agent") return "Message Agent — it has the repository and a shell…";
  if (mode === "assistant") return "Message Assistant — it reads this project, not the repository…";
  return "Ask the agent about this project…";
}

function labelOf(mode: ConversationMode): string {
  return MODES.find((m) => m.mode === mode)?.label ?? mode;
}

/** The reason core sends is a clause; the panel prints it as a sentence. */
function asSentence(clause: string): string {
  const text = clause.trim();
  if (!text) return text;
  const capital = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

/**
 * Why Agent cannot be picked, and the way out of it. Pressable rather than
 * greyed out: a control with a condition names the condition.
 *
 * Escape is taken here and marked taken, so the dock or slide-over this
 * composer sits in does not read the same key as its own close.
 */
function BlockedPanel({
  reason,
  onClose,
}: {
  reason: string | null;
  onClose: (returnFocus: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const wayOut = useRef<HTMLAnchorElement>(null);
  // The control that opened this may have just been unmounted with the menu it
  // was in, so the keyboard has nowhere to stand unless this takes it. It lands
  // on the way out the panel offers rather than on the explanation.
  useEffect(() => {
    wayOut.current?.focus();
  }, []);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);
  return (
    <div
      ref={ref}
      id="conversation-mode-blocked"
      role="dialog"
      aria-label="Agent is unavailable"
      data-testid="mode-blocked-panel"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onClose(true);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onClose(false);
      }}
      className="absolute bottom-full left-0 z-20 mb-2 w-72 rounded-md border border-line bg-surface p-3 shadow-lg"
    >
      <p className="fg-body-sm font-semibold text-fg">Agent needs a paired runner</p>
      <p className="fg-caption mt-1 text-muted">
        {asSentence(reason ?? "no runner is paired with this project")}
      </p>
      <Link
        ref={wayOut}
        href={PAIR_A_RUNNER}
        className="fg-body-sm mt-2.5 inline-flex items-center gap-1.5 rounded-sm text-link hover:underline"
      >
        <Icon name="link" size={14} />
        Pair a runner
      </Link>
    </div>
  );
}

/** The two options as a radiogroup on one track. */
function ModeTrack({
  value,
  onChange,
  blocked,
  disabled,
  onBlockedPress,
  describedBy,
}: {
  value: ConversationMode;
  onChange: (mode: ConversationMode) => void;
  blocked: boolean;
  disabled: boolean | undefined;
  onBlockedPress: () => void;
  describedBy: string | undefined;
}) {
  return (
    <fieldset
      className="flex items-center gap-0.5 rounded-md border border-line bg-sunken p-0.5"
      data-testid="conversation-mode-toggle"
    >
      <legend className="sr-only">What this conversation talks to</legend>
      {MODES.map(({ mode, label, hint }) => {
        const isBlocked = mode === "agent" && blocked;
        const selected = value === mode;
        return (
          <label
            key={mode}
            data-mode={mode}
            data-blocked={isBlocked ? "true" : undefined}
            className={[
              "inline-flex cursor-pointer items-center gap-1.5 rounded-sm px-2.5 py-1 text-13 font-semibold",
              "transition-colors focus-within:shadow-[var(--shadow-focus)]",
              selected ? "bg-surface text-fg shadow-xs" : "text-muted hover:text-fg",
            ].join(" ")}
          >
            <input
              type="radio"
              name="conversation-mode"
              className="sr-only"
              value={mode}
              checked={selected}
              disabled={disabled}
              aria-describedby={isBlocked ? describedBy : undefined}
              title={isBlocked ? undefined : hint}
              onChange={() => (isBlocked ? onBlockedPress() : onChange(mode))}
            />
            {label}
            {isBlocked && (
              <span
                aria-hidden="true"
                data-testid="mode-condition-dot"
                className="size-1.5 rounded-full bg-amber"
              />
            )}
          </label>
        );
      })}
    </fieldset>
  );
}

/** The same choice where the footer is too narrow for a track. */
function ModeMenu({
  value,
  onChange,
  blocked,
  disabled,
  onBlockedPress,
}: {
  value: ConversationMode;
  onChange: (mode: ConversationMode) => void;
  blocked: boolean;
  disabled: boolean | undefined;
  onBlockedPress: () => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  /** Close, and put the caret back where the person left it. */
  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  // Opening a menu that keeps the keyboard outside it is a menu a keyboard
  // cannot use: focus lands on the option already chosen.
  useEffect(() => {
    if (!open) return;
    const checked = MODES.findIndex((m) => m.mode === value);
    itemRefs.current[checked < 0 ? 0 : checked]?.focus();
  }, [open, value]);

  const onItemKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const step = e.key === "ArrowDown" ? 1 : -1;
    const next = (index + step + MODES.length) % MODES.length;
    itemRefs.current[next]?.focus();
  };

  return (
    <div className="relative">
      <button
        type="button"
        ref={triggerRef}
        disabled={disabled}
        data-testid="conversation-mode-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.preventDefault();
            e.stopPropagation();
            close(true);
          }
        }}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded-md border border-line bg-sunken px-2.5 py-1.5 text-13 font-semibold text-fg"
      >
        {labelOf(value)}
        <Icon name="chevronDown" size={13} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="What this conversation talks to"
          data-testid="conversation-mode-menu"
          onBlur={(e) => {
            // The keyboard left the menu for something outside it: close, and
            // do not drag the caret back to the trigger it is leaving.
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) close(false);
          }}
          className="absolute bottom-full left-0 z-20 mb-2 w-64 rounded-md border border-line bg-surface p-1 shadow-lg"
        >
          {MODES.map(({ mode, label, hint }, index) => {
            const isBlocked = mode === "agent" && blocked;
            return (
              <button
                key={mode}
                type="button"
                role="menuitemradio"
                aria-checked={value === mode}
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                onKeyDown={(e) => onItemKeyDown(e, index)}
                onClick={() => {
                  close(!isBlocked);
                  if (isBlocked) onBlockedPress();
                  else onChange(mode);
                }}
                className="flex w-full flex-col items-start gap-0.5 rounded-sm px-2 py-1.5 text-left hover:bg-sunken"
              >
                <span className="fg-body-sm font-semibold text-fg">{label}</span>
                <span className="fg-caption text-muted">{hint}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ConversationModeControl({
  value,
  onChange,
  offer,
  settled,
  narrow,
  disabled,
}: {
  value: ConversationMode;
  onChange: (mode: ConversationMode) => void;
  /** Whether Agent may be picked at all, and why not where it may not. */
  offer: AgentModeOffer;
  /** The mode this room already answers in, or null while it is still a choice. */
  settled: ConversationMode | null;
  /**
   * Force the menu form. Left out, the control reads the composer's own width
   * and takes the menu below `TRACK_MIN_WIDTH` — a pane is not a viewport, and
   * the ask-agent dock is 420px inside a full-width window.
   */
  narrow?: boolean;
  /** The whole control, while a send is in flight. */
  disabled?: boolean;
}) {
  const [blockedOpen, setBlockedOpen] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
  // Closing the panel from the keyboard puts the caret back on the control it
  // was opened from: the checked radio in the track, the button in the menu.
  const closeBlocked = useCallback((returnFocus: boolean) => {
    setBlockedOpen(false);
    if (!returnFocus) return;
    holder.current
      ?.querySelector<HTMLElement>(
        'input[type="radio"]:checked, [data-testid="conversation-mode-menu-trigger"]',
      )
      ?.focus();
  }, []);
  const composerWidth = useContext(ComposerWidthContext);
  const asMenu = narrow ?? (composerWidth !== null && composerWidth < TRACK_MIN_WIDTH);

  if (settled) {
    return (
      <span
        data-testid="conversation-mode-settled"
        className="inline-flex items-center gap-1.5 rounded-md bg-sunken px-2.5 py-1 text-13 font-semibold text-muted"
      >
        <Icon name="agent" size={13} />
        {labelOf(settled)}
      </span>
    );
  }

  const blocked = !offer.available;
  return (
    <div className="relative" ref={holder}>
      {asMenu ? (
        <ModeMenu
          value={value}
          onChange={onChange}
          blocked={blocked}
          disabled={disabled}
          onBlockedPress={() => setBlockedOpen(true)}
        />
      ) : (
        <ModeTrack
          value={value}
          onChange={onChange}
          blocked={blocked}
          disabled={disabled}
          onBlockedPress={() => setBlockedOpen(true)}
          describedBy={blockedOpen ? "conversation-mode-blocked" : undefined}
        />
      )}
      {blockedOpen && (
        <BlockedPanel reason={offer.reason} onClose={closeBlocked} />
      )}
    </div>
  );
}
