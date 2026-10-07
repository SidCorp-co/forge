"use client";

import { FEEDBACK_KINDS, FEEDBACK_SEVERITIES } from "@forge/contracts/feedback";
import { useState } from "react";
import { Button, enumLabel, Field, Input, NativeSelect, statusReading, Textarea } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { useSubmitGuard } from "@/lib/utils/use-submit-guard";
import { StagedFileList } from "@/features/attachments/components/staged-files";
import { AttachFailed } from "../api";
import { useAttachFeedback, useCreateFeedback, usePromoteFeedback } from "../hooks";
import type { CreateFeedbackRequest, FeedbackKind, FeedbackSeverity } from "../types";
import { useFeedbackStaging } from "./feedback-attachments";
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
  const attach = useAttachFeedback(projectId);
  const staged = useFeedbackStaging(0);
  const submitting = useSubmitGuard();
  const [kind, setKind] = useState<FeedbackKind>(draft.kind);
  const [severity, setSeverity] = useState<FeedbackSeverity>(draft.severity);
  const [targetType, setTargetType] = useState<PickableTarget>(draft.targetType);
  const [target, setTarget] = useState(draft.target);
  const [title, setTitle] = useState(draft.title);
  const [body, setBody] = useState(draft.body);
  const failed = attach.error instanceof AttachFailed ? attach.error : null;
  // the item is filed first; each staged file then goes to the key core answered with
  const filed = (key: string) => {
    if (staged.files.length === 0) return onDone(key);
    attach.mutate({ key, files: staged.files }, { onSuccess: () => onDone(key) });
  };
  return (
    <form
      className="grid max-w-2xl gap-3 bg-surface px-4 py-4 sm:px-7"
      data-testid={agentReport ? "feedback-promote" : "feedback-create"}
      onPaste={staged.onPaste}
      onSubmit={(e) => {
        e.preventDefault();
        const request: CreateFeedbackRequest = {
          kind,
          severity,
          title: title.trim(),
          ...(body.trim() ? { body } : {}),
          [targetType]: target.trim(),
        };
        if (attach.isPending || failed || !submitting.claim()) return;
        const settle = { onSuccess: (r: { feedback: { key: string } }) => filed(r.feedback.key), onSettled: submitting.release };
        if (agentReport) promote.mutate({ ...request, agentReport }, settle);
        else create.mutate(request, settle);
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
      <div {...staged.dropZone} className={staged.dragOver ? "ring-2 ring-cobalt-400 ring-offset-1" : undefined}>
        <Field label={t("feedback.form.body")} hint={t("feedback.form.bodyHint")}>
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} />
        </Field>
      </div>
      <StagedFileList files={staged.files} warnings={staged.warnings} remove={staged.remove} />
      {agentReport ? <p className="text-12-5 text-muted">{t("feedback.form.copied", { id: agentReport.slice(0, 8) })}</p> : null}
      <RefusalLine error={write.error} />
      {failed ? (
        <div className="grid gap-1.5" data-testid="feedback-attach-failed">
          <p className="text-13">{t("feedback.attach.failed", { key: failed.key, file: failed.file })}</p>
          <RefusalLine error={failed.refusal} />
          <div>
            <Button type="button" variant="primary" size="sm" onClick={() => onDone(failed.key)}>
              {t("feedback.attach.open", { key: failed.key })}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={write.isPending || attach.isPending}
            disabled={!title.trim() || !target.trim()}
          >
            {agentReport ? t("feedback.form.promote") : t("feedback.form.send")}
          </Button>
          <Button type="button" variant="ghost" size="sm" icon="plus" onClick={staged.choose} disabled={write.isPending || attach.isPending}>
            {t("feedback.attach.choose")}
          </Button>
          {staged.input}
          <Button type="button" variant="ghost" size="sm" onClick={() => onDone("")} disabled={write.isPending || attach.isPending}>
            {t("feedback.form.cancel")}
          </Button>
        </div>
      )}
    </form>
  );
}
