"use client";

import { FEEDBACK_TARGET_TYPES } from "@forge/contracts/feedback";
import { useState } from "react";
import { Button, enumLabel, Field, Input, NativeSelect } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useFeedbackAction } from "../hooks";
import type { FeedbackTargetType, FeedbackView } from "../types";

type Movable = Exclude<FeedbackTargetType, "contract">;
const MOVABLE = FEEDBACK_TARGET_TYPES.filter((t): t is Movable => t !== "contract");

const about = (t: FeedbackView["target"]) => `${enumLabel("feedbackTarget", t.type).toLowerCase()} ${t.key}`;

/**
 * Correct what an item is about (ISS-264), at any phase: an item filed about a screen moves to the
 * requirement that later records its rule. Shown by core's `can.retarget`; a refusal names why and
 * keeps what was typed.
 */
export function RetargetForm({ projectId, f }: { projectId: string; f: FeedbackView }) {
  const act = useFeedbackAction(projectId, f.key);
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<Movable>("requirement");
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const moved = act.data?.feedback.target;
  if (!open) {
    return (
      <div className="grid gap-1" data-testid="feedback-retarget">
        {moved ? <p className="text-12 text-muted">Now about {about(moved)}.</p> : null}
        <button type="button" className="justify-self-start text-12 font-semibold text-muted hover:text-fg" onClick={() => setOpen(true)}>
          Change what it is about…
        </button>
      </div>
    );
  }
  const submit = () =>
    act.mutate(
      { kind: "retarget", request: { [type]: target.trim(), ...(reason.trim() ? { reason: reason.trim() } : {}) } },
      {
        onSuccess: () => {
          setOpen(false);
          setTarget("");
          setReason("");
        },
      },
    );
  return (
    <section className="grid gap-3" data-testid="feedback-retarget">
      <h3 className="text-12 font-semibold text-muted">What it is about</h3>
      <p className="text-12 text-muted">Now {about(f.target)}. Its route and phase stay as they are; the move is kept in its history.</p>
      <Field label="Move it to" hint="REQ-3, ISS-12, a release version, a workflow flow, or a screen name">
        <span className="flex gap-2">
          <NativeSelect
            aria-label="Target type"
            value={type}
            onChange={(e) => setType(e.target.value as Movable)}
            options={MOVABLE.map((t) => ({ value: t, label: enumLabel("feedbackTarget", t) }))}
          />
          <Input aria-label="Target" value={target} onChange={(e) => setTarget(e.target.value)} />
        </span>
      </Field>
      <Field label="Why (optional)">
        <Input aria-label="Why" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <RefusalLine error={act.error} />
      <div className="flex gap-2">
        <Button type="button" variant="primary" size="sm" loading={act.isPending} disabled={!target.trim()} onClick={submit}>
          Move it
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
