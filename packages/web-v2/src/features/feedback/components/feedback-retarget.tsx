"use client";

import { useState } from "react";
import { Button, enumLabel, Field, Input } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { useFeedbackAction } from "../hooks";
import type { FeedbackView } from "../types";
import { type PickableTarget, TargetPicker } from "./target-picker";

/** A target label mid-sentence: a leading ordinary word lower-cased ("requirement"), an acronym kept ("API route or tool"). */
const inSentence = (label: string) => (/^\p{Lu}\p{Ll}/u.test(label) ? `${label.charAt(0).toLowerCase()}${label.slice(1)}` : label);
const about = (t: FeedbackView["target"], language: string) => `${inSentence(enumLabel("feedbackTarget", t.type, language))} ${t.key}`;

/**
 * Correct what an item is about (ISS-264), at any phase: an item filed about a screen moves to the
 * requirement that later records its rule. Shown by core's `can.retarget`; a refusal names why and
 * keeps what was typed.
 */
export function RetargetForm({ projectId, f }: { projectId: string; f: FeedbackView }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const [open, setOpen] = useState(false);
  const [moved, setMoved] = useState<FeedbackView["target"] | null>(null);
  if (open) return <RetargetEditor projectId={projectId} f={f} onClose={() => setOpen(false)} onMoved={setMoved} />;
  return (
    <div className="grid gap-1" data-testid="feedback-retarget">
      {moved ? <p className="text-12 text-muted">{t("feedback.retarget.nowAbout", { about: about(moved, language) })}</p> : null}
      <button type="button" className="justify-self-start text-12 font-semibold text-muted hover:text-fg" onClick={() => setOpen(true)}>
        {t("feedback.retarget.open")}
      </button>
    </div>
  );
}

/** The open form: the new target, an optional reason, Move it or Cancel. */
export function RetargetEditor({
  projectId,
  f,
  onClose,
  onMoved,
}: {
  projectId: string;
  f: FeedbackView;
  onClose: () => void;
  onMoved: (target: FeedbackView["target"]) => void;
}) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const act = useFeedbackAction(projectId, f.key);
  const [type, setType] = useState<PickableTarget>("requirement");
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const submit = () =>
    act.mutate(
      { kind: "retarget", request: { [type]: target.trim(), ...(reason.trim() ? { reason: reason.trim() } : {}) } },
      {
        onSuccess: (r) => {
          onMoved(r.feedback.target);
          onClose();
        },
      },
    );
  return (
    <section className="grid gap-3" data-testid="feedback-retarget">
      <h3 className="text-12 font-semibold text-muted">{t("feedback.retarget.heading")}</h3>
      <p className="text-12 text-muted">{t("feedback.retarget.now", { about: about(f.target, language) })}</p>
      <Field label={t("feedback.retarget.moveTo")} hint={t("feedback.target.hint")}>
        <TargetPicker projectId={projectId} type={type} onType={setType} value={target} onValue={setTarget} />
      </Field>
      <Field label={t("feedback.retarget.why")}>
        <Input aria-label={t("feedback.retarget.whyAria")} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <RefusalLine error={act.error} />
      <div className="flex gap-2">
        <Button type="button" variant="primary" size="sm" loading={act.isPending} disabled={!target.trim()} onClick={submit}>
          {t("feedback.retarget.go")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {t("feedback.retarget.cancel")}
        </Button>
      </div>
    </section>
  );
}
