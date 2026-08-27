"use client";

// Inline model picker for the chat composer (ISS-718). Sits in the composer's
// single bordered row next to the attach `+`, matching the ISS-714 compact
// style. Same anchored-popover shape as `runner-picker.tsx`.
//
// It names the ACTIVE model, not a wish. Verified on claude 2.1.241 that a
// changed `--model` takes effect on a `--resume` follow-up (both directions,
// read back from the CLI's own `modelUsage`), so once a pick has been sent the
// label is the truth. Until then — a pick made before the first send of that
// pick — the panel says so instead of overclaiming.

import { useRef, useState } from "react";
import { Icon, Skeleton } from "@/design";
import { type ModelTier, MODEL_TIER_LABELS, MODEL_TIERS } from "../types";
import { useAnchoredMenu } from "./anchored-menu";

interface ModelPickerProps {
  /** The session's persisted model (`metadata.model`), null when never picked. */
  activeModel: ModelTier | null;
  /**
   * The local pick, as the same three-state the send takes: `undefined` =
   * untouched (show `activeModel`), `null` = explicitly back to Default, a tier
   * = that tier. Collapsing null into undefined would make "Default"
   * un-pickable.
   */
  pendingModel: ModelTier | null | undefined;
  /**
   * The pick has not been carried by a send yet. Owned by the caller, not
   * derived from `pendingModel !== activeModel` here: between a send resolving
   * and the session row refetching, those two differ while the pick HAS already
   * applied, and the note would then claim the opposite of what happened.
   */
  unsent?: boolean;
  onSelect: (model: ModelTier | null) => void;
  /** Viewers / no-device: show the current model but don't allow changing it. */
  disabled?: boolean;
  /** The session row is still loading — show a placeholder, not a wrong label. */
  loading?: boolean;
}

const DEFAULT_LABEL = "Default";

export function ModelPicker({
  activeModel,
  pendingModel,
  onSelect,
  disabled,
  loading,
  unsent,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const pos = useAnchoredMenu({
    open,
    onClose: () => setOpen(false),
    anchorRef: wrapRef,
    width: 260,
    placement: "above",
  });

  // cm:guard `??` is wrong here — `pendingModel` is a three-state (undefined = untouched, null = explicitly Default, a tier = that tier), and `??` would let an explicit null fall through to the persisted model, making Default un-pickable
  const effective = pendingModel === undefined ? activeModel : pendingModel;
  const triggerLabel = effective ? MODEL_TIER_LABELS[effective].label : DEFAULT_LABEL;

  const pick = (model: ModelTier | null) => {
    onSelect(model);
    setOpen(false);
  };

  return (
    <div ref={wrapRef} className="relative flex-none">
      <button
        type="button"
        // cm:guard no leading icon, and a 5rem cap at base width — at 375px the row already carries three 44px touch targets, and every pixel this trigger takes comes straight off the textarea
        disabled={disabled || loading}
        onClick={() => !disabled && !loading && setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Model this conversation runs on — ${triggerLabel}`}
        className="inline-flex h-11 max-w-[5rem] items-center gap-0.5 rounded-xl px-1.5 text-[13px] text-fg transition-colors hover:bg-hover disabled:cursor-default disabled:opacity-70 sm:max-w-[8rem] sm:gap-1 sm:px-2"
      >
        {loading ? (
          <Skeleton variant="text" className="w-10" />
        ) : (
          <span className="truncate">{triggerLabel}</span>
        )}
        {!disabled && !loading && (
          <Icon name="chevronDown" size={13} className="flex-none text-subtle" />
        )}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Choose a model"
          style={{
            top: pos?.top,
            bottom: pos?.bottom,
            left: pos?.left,
            width: pos?.width,
            visibility: pos ? undefined : "hidden",
          }}
          className="forge-drop fixed z-50 overflow-hidden rounded-lg border border-line bg-surface p-1.5 shadow-lg"
        >
          <div className="px-2 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-subtle">
            Model
          </div>
          {unsent && (
            <div className="px-2 pb-1.5 text-[12px] text-subtle">
              Applies from your next message.
            </div>
          )}

          <ModelRow
            label={DEFAULT_LABEL}
            sub="Claude Code's configured default"
            selected={effective === null}
            onSelect={() => pick(null)}
          />
          {MODEL_TIERS.map((tier) => (
            <ModelRow
              key={tier}
              label={MODEL_TIER_LABELS[tier].label}
              sub={MODEL_TIER_LABELS[tier].sub}
              selected={effective === tier}
              onSelect={() => pick(tier)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ModelRow({
  label,
  sub,
  selected,
  onSelect,
}: {
  label: string;
  sub: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onSelect}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-fg">{label}</span>
        <span className="block truncate text-[11px] text-subtle">{sub}</span>
      </span>
      {selected && <Icon name="check" size={14} className="flex-none text-accent-text" />}
    </button>
  );
}
