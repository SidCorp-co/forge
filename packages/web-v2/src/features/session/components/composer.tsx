"use client";

import { Button, Textarea } from "@/design";
// Sticky message composer — Textarea + Send. Enter sends, Shift+Enter inserts a
// newline. Shared by the run thread + Chat. ≥44px touch targets, sticky bottom.
import { type KeyboardEvent, useState } from "react";

interface ComposerProps {
  /**
   * Deliver the message. MUST reject (throw) on failure — the composer clears
   * the input only when this resolves, so a failed send keeps the typed text
   * for retry instead of discarding it (ISS-462).
   */
  onSend: (message: string) => Promise<void>;
  /** Disable input entirely (e.g. no device available). */
  disabled?: boolean;
  /** Send is in flight / the agent is busy. */
  busy?: boolean;
  placeholder?: string;
}

/** Rendered in place of the Composer for project viewers (read-only role). */
export function ReadOnlyComposerNote() {
  return (
    <div className="sticky bottom-0 z-10 border-t border-line bg-app/95 px-4 py-4 backdrop-blur sm:px-6">
      <p className="fg-body-sm text-center text-muted">Read-only access</p>
    </div>
  );
}

export function Composer({
  onSend,
  disabled,
  busy,
  placeholder = "Send a message…",
}: ComposerProps) {
  const [value, setValue] = useState("");
  const canSend = !disabled && !busy && value.trim().length > 0;

  const submit = async () => {
    if (!canSend) return;
    const text = value.trim();
    try {
      await onSend(text);
      // Clear only on success — a thrown send (e.g. 409 no online runner)
      // leaves the typed text in place so the user can retry (ISS-462).
      setValue("");
    } catch {
      // Keep the text; the parent surfaces the error (Banner + toast).
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="sticky bottom-0 z-10 border-t border-line bg-app/95 px-4 py-3 backdrop-blur sm:px-6">
      <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
        <Textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          rows={1}
          placeholder={
            disabled
              ? "No device online — start a runner to chat."
              : placeholder
          }
          className="max-h-40 min-h-11 flex-1"
          aria-label="Message"
        />
        <Button
          variant="primary"
          size="md"
          icon="arrowRight"
          className="min-h-11 min-w-11"
          loading={busy}
          disabled={!canSend}
          onClick={submit}
        >
          Send
        </Button>
      </div>
    </div>
  );
}
