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

import { type RefObject, useContext, useRef, useState } from "react";
import Link from "next/link";
import { Icon, Menu, Popover } from "@/design";
import { ComposerWidthContext } from "@/features/chat/components/chat-composer";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";
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
  label: ProductCopyKey;
}

/** Each mode by its label (the product copy's keys). */
export const MODES: ModeMeta[] = [
  { mode: "assistant", label: "shell.mode.assistant" },
  { mode: "agent", label: "shell.mode.agent" },
];

/** The box's own placeholder, so the mode is readable while typing too. */
export function modePlaceholder(mode: ConversationMode | null, t: Copy): string {
  if (mode === "agent") return t("shell.mode.agentPlaceholder");
  if (mode === "assistant") return t("shell.mode.assistantPlaceholder");
  return t("shell.mode.placeholder");
}

function labelOf(mode: ConversationMode, t: Copy): string {
  const key = MODES.find((m) => m.mode === mode)?.label;
  return key ? t(key) : mode;
}

/** The reason core sends is a clause; the panel prints it as a sentence. */
function asSentence(clause: string): string {
  const text = clause.trim();
  if (!text) return text;
  const capital = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

/**
 * Why Agent cannot be picked, and the way out of it, anchored on the control. Pressable rather than
 * greyed out: a control with a condition names the condition. Focus, Escape and outside press are
 * the Popover's.
 */
function BlockedNote({ anchor, reason, onClose }: { anchor: RefObject<HTMLElement | null>; reason: string | null | undefined; onClose: () => void }) {
  const t = useCopy();
  return (
    <Popover
      open
      anchor={anchor}
      placement="top-start"
      takesFocus
      onDismiss={onClose}
      id="conversation-mode-blocked"
      aria-label={t("shell.mode.unavailable")}
      data-testid="mode-blocked-panel"
      className="w-72 p-3"
    >
      <p className="fg-body-sm font-semibold text-fg">{t("shell.mode.needsRunner")}</p>
      <p className="fg-caption mt-1 text-muted">{reason ? asSentence(reason) : t("shell.mode.noRunner")}</p>
      <Link href={PAIR_A_RUNNER} className="fg-body-sm mt-2.5 inline-flex items-center gap-1.5 rounded-sm text-link hover:underline">
        <Icon name="link" size={14} />
        {t("shell.mode.pairRunner")}
      </Link>
    </Popover>
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
  const t = useCopy();
  return (
    <fieldset
      className="flex items-center gap-0.5 rounded-md border border-line bg-sunken p-0.5"
      data-testid="conversation-mode-toggle"
    >
      <legend className="sr-only">{t("shell.mode.legend")}</legend>
      {MODES.map(({ mode, label }) => {
        const isBlocked = mode === "agent" && blocked;
        const selected = value === mode;
        return (
          <label
            key={mode}
            data-mode={mode}
            data-blocked={isBlocked ? "true" : undefined}
            className={[
              "inline-flex cursor-pointer items-center gap-1.5 rounded-sm px-2.5 py-1 text-13 font-semibold",
              "transition-colors focus-within:shadow-focus",
              selected ? "bg-surface text-fg " : "text-muted hover:text-fg",
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
              onChange={() => (isBlocked ? onBlockedPress() : onChange(mode))}
            />
            {t(label)}
            {isBlocked && (
              <span
                aria-hidden="true"
                data-testid="mode-condition-dot"
                className="size-1.5 rounded-pill bg-warn-9"
              />
            )}
          </label>
        );
      })}
    </fieldset>
  );
}

/** The same choice where the footer is too narrow for a track: the design Menu, its items checked. */
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
  const t = useCopy();
  return (
    <Menu
      align="left"
      side="top"
      trigger={
        <button
          type="button"
          disabled={disabled}
          data-testid="conversation-mode-menu-trigger"
          className="inline-flex items-center gap-1.5 rounded-md border border-line bg-sunken px-2.5 py-1.5 text-13 font-semibold text-fg"
        >
          {labelOf(value, t)}
          <Icon name="chevronDown" size={13} />
        </button>
      }
      items={MODES.map(({ mode, label }) => ({
        label: t(label),
        checked: value === mode,
        onSelect: () => (mode === "agent" && blocked ? onBlockedPress() : onChange(mode)),
      }))}
    />
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
  const composerWidth = useContext(ComposerWidthContext);
  const t = useCopy();
  const asMenu = narrow ?? (composerWidth !== null && composerWidth < TRACK_MIN_WIDTH);

  if (settled) {
    return (
      <span
        data-testid="conversation-mode-settled"
        className="inline-flex items-center gap-1.5 rounded-md bg-sunken px-2.5 py-1 text-13 font-semibold text-muted"
      >
        <Icon name="agent" size={13} />
        {labelOf(settled, t)}
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
      {blockedOpen ? <BlockedNote anchor={holder} reason={offer.reason} onClose={() => setBlockedOpen(false)} /> : null}
    </div>
  );
}
