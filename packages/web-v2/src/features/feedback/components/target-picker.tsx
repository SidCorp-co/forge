"use client";

import { FEEDBACK_TARGET_TYPES } from "@forge/contracts/feedback";
import { useId } from "react";
import { enumLabel, Input, NativeSelect } from "@/design";
import { useFeedbackEndpoints } from "../hooks";
import type { FeedbackTargetType } from "../types";

/** Every target a person may name; a contract version is core's alone (E3). */
export type PickableTarget = Exclude<FeedbackTargetType, "contract">;
export const PICKABLE_TARGETS = FEEDBACK_TARGET_TYPES.filter((t): t is PickableTarget => t !== "contract");

export const TARGET_HINT = "REQ-3, ISS-12, a release version, a workflow flow, a route or tool the project serves, or a screen name";

/**
 * The About picker (ISS-279): the target's type and its reference. On "API route or tool" the input
 * suggests what the project serves, read from core; core still checks the name, so a typed one it
 * does not serve is refused by name.
 */
export function TargetPicker({
  projectId,
  type,
  onType,
  value,
  onValue,
}: {
  projectId: string;
  type: PickableTarget;
  onType: (t: PickableTarget) => void;
  value: string;
  onValue: (v: string) => void;
}) {
  const listId = useId();
  const endpoints = useFeedbackEndpoints(projectId, type === "endpoint");
  const served = type === "endpoint" ? (endpoints.data?.endpoints ?? []) : [];
  return (
    <span className="flex gap-2">
      <NativeSelect
        aria-label="Target type"
        value={type}
        onChange={(e) => onType(e.target.value as PickableTarget)}
        options={PICKABLE_TARGETS.map((t) => ({ value: t, label: enumLabel("feedbackTarget", t) }))}
      />
      <Input aria-label="Target" value={value} onChange={(e) => onValue(e.target.value)} list={served.length ? listId : undefined} />
      {served.length ? (
        <datalist id={listId} data-testid="feedback-endpoints">
          {served.map((s) => (
            <option key={s.key} value={s.key}>
              {`${s.type === "openapi" ? "Route" : "Tool"} ${s.element} · ${s.contract} ${s.version}`}
            </option>
          ))}
        </datalist>
      ) : null}
    </span>
  );
}
