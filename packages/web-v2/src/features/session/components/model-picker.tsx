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
import { Icon } from "@/design";
import { type ModelTier, MODEL_TIER_LABELS, MODEL_TIERS } from "../types";
import { useAnchoredMenu } from "./anchored-menu";

interface ModelPickerProps {
  /** The session's persisted model (`metadata.model`), null when never picked. */
  activeModel: ModelTier | null;
  /**
   * A pick not yet carried by a send, as the same three-state the send takes:
   * `undefined` = untouched, `null` = explicitly back to Default, a tier = that
   * tier. Collapsing null into undefined would make "Default" un-pickable.
   */
  pendingModel: ModelTier | null | undefined;
  /** null selects "Default" — send no override and let the runner decide. */
  onSelect: (model: ModelTier | null) => void;
  /** Viewers / no-device: show the current model but don't allow changing it. */
  disabled?: boolean;
}

const DEFAULT_LABEL = "Default";

export function ModelPicker({
  activeModel,
  pendingModel,
  onSelect,
  disabled,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const pos = useAnchoredMenu({
    open,
    onClose: () => setOpen(false),
    anchorRef: wrapRef,
    width: 260,
    placement: "above",
    maxHeight: 240,
  });

  // cm:guard `??` is wrong here — `pendingModel` is a three-state (undefined = untouched, null = explicitly Default, a tier = that tier), and `??` would let an explicit null fall through to the persisted model, making Default un-pickable
  const effective = pendingModel === undefined ? activeModel : pendingModel;
  const unsent = pendingModel !== undefined && pendingModel !== activeModel;
  const triggerLabel = effective ? MODEL_TIER_LABELS[effective].label : DEFAULT_LABEL;

  const pick = (model: ModelTier | null) => {
    onSelect(model);
    setOpen(false);
  };

  return (
    <div ref={wrapRef} className="relative flex-none">
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Model this conversation runs on"
        className="inline-flex h-11 max-w-[7.5rem] items-center gap-1 rounded-xl px-2 text-[13px] text-fg transition-colors hover:bg-hover disabled:cursor-default disabled:opacity-70 sm:max-w-[9rem]"
      >
        <Icon name="cpu" size={15} className="flex-none text-subtle" />
        <span className="truncate">{triggerLabel}</span>
        {!disabled && <Icon name="chevronDown" size={13} className="flex-none text-subtle" />}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Choose a model"
          style={{
            top: pos?.top,
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
            sub="Whatever the runner is set to"
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
