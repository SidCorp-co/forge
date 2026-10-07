"use client";

import { FEEDBACK_KINDS, FEEDBACK_SEVERITIES } from "@forge/contracts/feedback";
import { useState } from "react";
import { Button, enumLabel, Field, Input, NativeSelect, statusReading, Textarea } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { useCreateFeedback, usePromoteFeedback } from "../hooks";
import type { CreateFeedbackRequest, FeedbackKind, FeedbackSeverity } from "../types";
import { type PickableTarget, TargetPicker } from "./target-picker";

export interface FeedbackDraft {
  kind: FeedbackKind;
  severity: FeedbackSeverity;
  targetType: PickableTarget;
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
  const t = useCopy();
  const language = useInterfaceLanguage();
  const create = useCreateFeedback(projectId);
  const promote = usePromoteFeedback(projectId);
  const write = agentReport ? promote : create;
  const [kind, setKind] = useState<FeedbackKind>(draft.kind);
  const [severity, setSeverity] = useState<FeedbackSeverity>(draft.severity);
  const [targetType, setTargetType] = useState<PickableTarget>(draft.targetType);
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
      <Field label={t("feedback.form.title")} required>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </Field>
      <div className="grid gap-3 sm:grid-cols-[10rem_10rem_minmax(0,1fr)]">
        <Field label={t("feedback.form.kind")}>
          <NativeSelect
            value={kind}
            onChange={(e) => setKind(e.target.value as FeedbackKind)}
            options={FEEDBACK_KINDS.filter((k) => k !== "contract_change").map((k) => ({ value: k, label: enumLabel("feedbackKind", k, language) }))}
          />
        </Field>
        <Field label={t("feedback.form.severity")}>
          <NativeSelect
            value={severity}
            onChange={(e) => setSeverity(e.target.value as FeedbackSeverity)}
            options={FEEDBACK_SEVERITIES.map((v) => ({ value: v, label: statusReading("severity", v, language).label }))}
          />
        </Field>
        <Field label={t("feedback.form.about")} hint={t("feedback.target.hint")}>
          <TargetPicker projectId={projectId} type={targetType} onType={setTargetType} value={target} onValue={setTarget} />
        </Field>
      </div>
      <Field label={t("feedback.form.body")} hint={t("feedback.form.bodyHint")}>
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} />
      </Field>
      {agentReport ? <p className="text-12-5 text-muted">{t("feedback.form.copied", { id: agentReport.slice(0, 8) })}</p> : null}
      <RefusalLine error={write.error} />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" loading={write.isPending} disabled={!title.trim() || !target.trim()}>
          {agentReport ? t("feedback.form.promote") : t("feedback.form.send")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => onDone("")}>
          {t("feedback.form.cancel")}
        </Button>
      </div>
    </form>
  );
}
