"use client";

// Where this issue's own work lands, set by a person through the door an agent uses
// (`PATCH /api/issues/:id` `landingShape`). The door's rules are its own: a merge mark is judged on
// the lane it was made under, so a change while one stands is refused by name and said here.

import { useState } from "react";
import { formatApiReason, LANDING_SHAPE_ROW } from "@/lib/api/error";
import { useDeclareLandingShape } from "../hooks";
import type { LandingShape } from "../types";
import { InlineSelect } from "./inline-edit-cell";

const SHAPE_TEXT: Record<LandingShape, string> = { git: "In git", outside_git: "Outside git" };

/** `""` is no declaration of its own: the project's shape decides. */
const FROM_PROJECT = "";

export function LandingShapeControl({
  issueId,
  declared,
  effective,
  disabled,
}: {
  issueId: string;
  declared: LandingShape | null;
  /** Core's answer for the lane this issue is on now. */
  effective: LandingShape | undefined;
  disabled: boolean;
}) {
  const declare = useDeclareLandingShape(issueId);
  const [refusal, setRefusal] = useState<string | null>(null);
  const options = [
    {
      value: FROM_PROJECT,
      label: declared === null && effective ? `Project: ${SHAPE_TEXT[effective].toLowerCase()}` : "As the project",
    },
    { value: "git", label: SHAPE_TEXT.git },
    { value: "outside_git", label: SHAPE_TEXT.outside_git },
  ];

  return (
    <div className="flex flex-col items-end gap-1">
      <InlineSelect
        ariaLabel={LANDING_SHAPE_ROW}
        value={declared ?? FROM_PROJECT}
        options={options}
        disabled={disabled || declare.isPending}
        onCommit={(next) => {
          setRefusal(null);
          declare.mutate(next === FROM_PROJECT ? null : (next as LandingShape), {
            onError: (err) => setRefusal(formatApiReason(err)),
          });
        }}
        className="w-44"
      />
      {refusal && (
        <p role="alert" className="max-w-64 text-left text-[12px] leading-[1.35] text-danger" data-testid="landing-shape-refusal">
          {refusal}
        </p>
      )}
    </div>
  );
}
