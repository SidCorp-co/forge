
import { useState } from "react";
import { Button, DetailDrawer, enumLabel, Field, Input } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { useFeedbackAction } from "../hooks";
import type { FeedbackView } from "../types";
import { type PickableTarget, TargetPicker } from "./target-picker";

/** A target label mid-sentence: a leading ordinary word lower-cased ("requirement"), an acronym kept ("API …"). */
const inSentence = (label: string) => (/^\p{Lu}\p{Ll}/u.test(label) ? `${label.charAt(0).toLowerCase()}${label.slice(1)}` : label);
const about = (t: FeedbackView["target"], language: string) => `${inSentence(enumLabel("feedbackTarget", t.type, language))} ${t.key}`;

/**
 * Correct what an item is about (ISS-264), at any phase: an item filed about a screen moves to the
 * requirement that later records its rule. The palette's act opens it in a side sheet (ISS-903), offered
 * by core's `can.retarget`; a refusal names why and keeps what was typed, and a move says the new target.
 */
export function RetargetSheet({ projectId, f, open, onOpenChange }: { projectId: string; f: FeedbackView; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const [moved, setMoved] = useState<FeedbackView["target"] | null>(null);
  const shut = (next: boolean) => {
    if (!next) setMoved(null);
    onOpenChange(next);
  };
  return (
    <DetailDrawer label={t("feedback.retarget.heading")} trigger={false} open={open} onOpenChange={shut}>
      {moved ? (
        <p className="text-13" data-testid="feedback-retarget-moved">
          {t("feedback.retarget.nowAbout", { about: about(moved, language) })}
        </p>
      ) : (
        <RetargetEditor projectId={projectId} f={f} onClose={() => shut(false)} onMoved={setMoved} />
      )}
    </DetailDrawer>
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
        onSuccess: (r) => onMoved(r.feedback.target),
      },
    );
  return (
    <section className="grid gap-3" data-testid="feedback-retarget">
      <h3 className="text-12 font-semibold text-muted">{t("feedback.retarget.heading")}</h3>
      <p className="text-12 text-muted">{t("feedback.retarget.now", { about: about(f.target, language) })}</p>
      <Field label={t("feedback.retarget.moveTo")}>
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
