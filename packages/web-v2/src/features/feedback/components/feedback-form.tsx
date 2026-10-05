"use client";

import { FEEDBACK_KINDS, FEEDBACK_SEVERITIES, FEEDBACK_TARGET_TYPES } from "@forge/contracts/feedback";
import { useState } from "react";
import { Button, enumLabel, Field, Input, NativeSelect, statusReading, Textarea, RefusalLine } from "@/design";
import { useCreateFeedback, usePromoteFeedback } from "../hooks";
import type { CreateFeedbackRequest, FeedbackKind, FeedbackSeverity, FeedbackTargetType } from "../types";

export interface FeedbackDraft {
  kind: FeedbackKind;
  severity: FeedbackSeverity;
  targetType: FeedbackTargetType;
  target: string;
  title: string;
  body: string;
}

const BLANK: FeedbackDraft = { kind: "bug", severity: "medium", targetType: "requirement", target: "", title: "", body: "" };

export function FeedbackForm({
  projectId,
  onDone,
  agentReport,
  draft = BLANK,
}: {
  projectId: string;
  onDone: (key: string) => void;
  agentReport?: string;
  draft?: FeedbackDraft;
}) {
  const create = useCreateFeedback(projectId);
  const promote = usePromoteFeedback(projectId);
  const write = agentReport ? promote : create;
  const [kind, setKind] = useState<FeedbackKind>(draft.kind);
  const [severity, setSeverity] = useState<FeedbackSeverity>(draft.severity);
  const [targetType, setTargetType] = useState<FeedbackTargetType>(draft.targetType);
  const [target, setTarget] = useState(draft.target);
  const [title, setTitle] = useState(draft.title);
  const [body, setBody] = useState(draft.body);
  return (
    <form
      className="grid max-w-2xl gap-3 bg-surface px-4 py-4 sm:px-7"
      data-testid={agentReport ? "feedback-promote" : "feedback-create"}
      onSubmit={(e) => {
        e.preventDefault();
        const request: CreateFeedbackRequest = {
          kind,
          severity,
          title: title.trim(),
          ...(body.trim() ? { body } : {}),
          [targetType]: target.trim(),
        };
        if (agentReport) promote.mutate({ ...request, agentReport }, { onSuccess: (r) => onDone(r.feedback.key) });
        else create.mutate(request, { onSuccess: (r) => onDone(r.feedback.key) });
      }}
    >
      <Field label="Title" required>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </Field>
      <div className="grid gap-3 sm:grid-cols-[10rem_10rem_minmax(0,1fr)]">
        <Field label="Kind">
          <NativeSelect
            value={kind}
            onChange={(e) => setKind(e.target.value as FeedbackKind)}
            options={FEEDBACK_KINDS.filter((k) => k !== "contract_change").map((k) => ({ value: k, label: enumLabel("feedbackKind", k) }))}
          />
        </Field>
        <Field label="Severity">
          <NativeSelect
            value={severity}
            onChange={(e) => setSeverity(e.target.value as FeedbackSeverity)}
            options={FEEDBACK_SEVERITIES.map((v) => ({ value: v, label: statusReading("severity", v).label }))}
          />
        </Field>
        <Field label="About" hint="REQ-3, ISS-12, a release version, a workflow flow, or a screen name">
          <span className="flex gap-2">
            <NativeSelect
              value={targetType}
              onChange={(e) => setTargetType(e.target.value as FeedbackTargetType)}
              options={FEEDBACK_TARGET_TYPES.filter((t) => t !== "contract").map((t) => ({ value: t, label: enumLabel("feedbackTarget", t) }))}
            />
            <Input value={target} onChange={(e) => setTarget(e.target.value)} />
          </span>
        </Field>
      </div>
      <Field label="What happened" hint="On a sensitive project personal data is scrubbed when it is saved">
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} />
      </Field>
      {agentReport ? <p className="text-12-5 text-muted">Copied from agent report {agentReport.slice(0, 8)}. The item keeps a link to the report, and the report shows the item it became.</p> : null}
      <RefusalLine error={write.error} />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" loading={write.isPending} disabled={!title.trim() || !target.trim()}>
          {agentReport ? "Promote to feedback" : "Send feedback"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => onDone("")}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
