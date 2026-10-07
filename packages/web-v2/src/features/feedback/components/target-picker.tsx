"use client";

import { FEEDBACK_TARGET_TYPES } from "@forge/contracts/feedback";
import { useEffect, useId, useState } from "react";
import { enumLabel, Input, NativeSelect } from "@/design";
import { type IssuePick, IssuePicker } from "@/features/issues/components/issue-picker";
import { useProjects } from "@/features/projects/hooks";
import { canWriteProject } from "@/features/projects/write-access";
import type { TargetChoice } from "../api";
import { useFeedbackChoices, useFeedbackEndpoints } from "../hooks";
import type { FeedbackTargetType } from "../types";

/** Every target a person may name; a contract version is core's alone (E3). */
export type PickableTarget = Exclude<FeedbackTargetType, "contract">;
const PICKABLE_TARGETS = FEEDBACK_TARGET_TYPES.filter((t): t is PickableTarget => t !== "contract");

export const TARGET_HINT = "Pick a requirement, workflow or release by its title, or name a route or tool the project serves, or a screen";

/** The kinds a person picks by title from the project's own list, never by a typed key. */
const LISTED: ReadonlySet<PickableTarget> = new Set<PickableTarget>(["requirement", "workflow", "release"]);

type Choice = TargetChoice;

/** The project's requirements, workflows or releases, by title; empty until the list has loaded. */
function useChoices(projectId: string, type: PickableTarget): { choices: Choice[]; loaded: boolean } {
  const q = useFeedbackChoices(projectId, type === "requirement" || type === "workflow" || type === "release" ? type : null);
  return { loaded: Boolean(q.data), choices: q.data ?? [] };
}

/** The choice a typed text names: its title (any case) or its key. */
export function choiceOf(choices: readonly Choice[], text: string): Choice | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  return choices.find((c) => c.title.toLowerCase() === t || c.key.toLowerCase() === t) ?? null;
}

/**
 * The About picker (ISS-279): the target's type and its reference. On "API route or tool" the input
 * suggests what the project serves, read from core; core still checks the name, so a typed one it
 * does not serve is refused by name. A project serving none says so before Send and points to a
 * Screen (ISS-278), rather than leaving it to that refusal.
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
  const servesNone = type === "endpoint" && endpoints.data?.endpoints.length === 0;
  const role = useProjects().data?.find((p) => p.id === projectId)?.role;
  const kinds = PICKABLE_TARGETS.filter((t) => t !== "issue" || canWriteProject(role));
  const { choices, loaded } = useChoices(projectId, type);
  const listed = LISTED.has(type);
  const [text, setText] = useState(value);
  const [issues, setIssues] = useState<IssuePick[]>([]);
  const [typed, setTyped] = useState(type);
  if (typed !== type) {
    setTyped(type);
    setText("");
    setIssues([]);
  }
  const picked = listed ? choiceOf(choices, text) : null;
  const pickedIssue = type === "issue" ? (issues[0]?.key ?? "") : null;
  // A listed kind reports its key only once the text names one of the list, and an issue only once
  // one is picked: anything else reports nothing, so Send stays off (never a guess, never a drop).
  useEffect(
    () => onValue(pickedIssue ?? (listed ? (picked?.key ?? "") : text)),
    [text, listed, picked?.key, pickedIssue, onValue],
  );
  const unmatched = listed && loaded && text.trim() !== "" && !picked;
  const noun = enumLabel("feedbackTarget", type).toLowerCase();
  return (
    <span className="grid gap-1">
      <span className="flex gap-2">
        <NativeSelect
          aria-label="Target type"
          value={type}
          onChange={(e) => onType(e.target.value as PickableTarget)}
          options={kinds.map((t) => ({ value: t, label: enumLabel("feedbackTarget", t) }))}
        />
        {type === "issue" ? (
          <span className="min-w-0 flex-1">
            <IssuePicker projectId={projectId} value={issues} onChange={setIssues} ariaLabel="Target" single />
          </span>
        ) : (
          <Input
            aria-label="Target"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={listed ? `Search ${noun}s by title` : undefined}
            list={served.length || (listed && choices.length) ? listId : undefined}
          />
        )}
        {served.length ? (
          <datalist id={listId} data-testid="feedback-endpoints">
            {served.map((s) => (
              <option key={s.key} value={s.key}>
                {`${s.type === "openapi" ? "Route" : "Tool"} ${s.element} · ${s.contract} ${s.version}`}
              </option>
            ))}
          </datalist>
        ) : null}
        {listed && choices.length ? (
          <datalist id={listId} data-testid="feedback-choices">
            {choices.map((c) => (
              <option key={c.key} value={c.title} label={c.key} />
            ))}
          </datalist>
        ) : null}
      </span>
      {unmatched ? (
        <span className="text-12 text-danger" data-testid="feedback-target-unmatched" role="alert">
          {`No ${noun} of this project is titled or keyed “${text.trim()}”: pick one from the list.`}
        </span>
      ) : null}
      {servesNone ? (
        <span className="text-12 text-muted" data-testid="feedback-endpoints-none">
          This project publishes no API routes or tools, so there is none to name here. File it as a Screen instead.
        </span>
      ) : null}
    </span>
  );
}
