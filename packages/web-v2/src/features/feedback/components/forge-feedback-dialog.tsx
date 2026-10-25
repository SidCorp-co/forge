// Feedback to Forge (REQ-47 BC-9): on every page, a short form about Forge itself, filed as the
// signed-in person into Forge's own home project — never into the project the page belongs to. The
// page it was opened on is where it was seen, and that project is where it came from.

import { FEEDBACK_KINDS, FEEDBACK_LIMITS } from "@forge/contracts/feedback";
import { useState } from "react";
import { Button, Dialog, enumLabel, Field, Input, NativeSelect, Textarea, focusOnMount } from "@/design";
import { useCurrentProject } from "@/features/projects";
import { placeRefusals } from "@/lib/api/field-refusals";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { Link, usePathname } from "@/lib/navigation/router";
import { useLocationSearch } from "@/lib/utils/use-location-search";
import { useSubmitGuard } from "@/lib/utils/use-submit-guard";
import { useSubmitForgeFeedback } from "../hooks";
import type { FeedbackKind, ForgeFeedbackFiled } from "../types";

const FIELDS = { title: ["/title"], kind: ["/kind"], body: ["/body"], where: ["/whereSeen", "/from"] } as const;

/** Where "your feedback to Forge" lives. */
export const MY_FORGE_FEEDBACK_HREF = "/forge-feedback";

export function ForgeFeedbackForm({ clientVersion, onFiled, onCancel }: { clientVersion?: string; onFiled: (filed: ForgeFeedbackFiled) => void; onCancel: () => void }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const write = useSubmitForgeFeedback();
  const submitting = useSubmitGuard();
  const project = useCurrentProject();
  const where = `${usePathname()}${useLocationSearch()}`;
  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const refused = placeRefusals(write.error, FIELDS);
  return (
    <form
      className="grid gap-3"
      data-testid="forge-feedback-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!submitting.claim()) return;
        write.mutate(
          {
            kind,
            title: title.trim(),
            whereSeen: where,
            ...(body.trim() ? { body } : {}),
            ...(clientVersion ? { clientVersion } : {}),
            ...(project ? { from: { project: project.id } } : {}),
          },
          { onSuccess: onFiled, onSettled: submitting.release },
        );
      }}
    >
      <Field label={t("feedback.form.kind")} error={refused.at("kind")}>
        <NativeSelect
          value={kind}
          onChange={(e) => setKind(e.target.value as FeedbackKind)}
          options={FEEDBACK_KINDS.filter((k) => k !== "contract_change").map((k) => ({ value: k, label: enumLabel("feedbackKind", k, language) }))}
        />
      </Field>
      <Field label={t("feedback.form.title")} error={refused.at("title")} required>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={FEEDBACK_LIMITS.title} ref={focusOnMount} />
      </Field>
      <Field label={t("feedback.forge.body")} error={refused.at("body")}>
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={FEEDBACK_LIMITS.body} />
      </Field>
      <p className="break-all text-12 text-muted" data-testid="forge-feedback-where">
        {t("feedback.forge.seenAt", { where })}
      </p>
      {refused.at("where") ? <p className="text-12 text-danger-11">{refused.at("where")}</p> : null}
      <RefusalLine error={write.error} onField={refused.onField} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={write.isPending}>
          {t("feedback.form.cancel")}
        </Button>
        <Button type="submit" variant="primary" size="sm" loading={write.isPending} disabled={!title.trim()}>
          {t("feedback.forge.send")}
        </Button>
      </div>
    </form>
  );
}

export function ForgeFeedbackFiledNote({ filed, onClose }: { filed: ForgeFeedbackFiled; onClose: () => void }) {
  const t = useCopy();
  const key = filed.feedback.key;
  return (
    <div className="grid gap-3" data-testid="forge-feedback-filed">
      <p className="text-13">{filed.created ? t("feedback.forge.filed", { key }) : t("feedback.forge.joined", { key })}</p>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Link href={MY_FORGE_FEEDBACK_HREF} onClick={onClose} className="text-13 text-link hover:underline">
          {t("feedback.forge.mine")}
        </Link>
        <Button type="button" variant="primary" size="sm" onClick={onClose}>
          {t("feedback.forge.done")}
        </Button>
      </div>
    </div>
  );
}

/**
 * The shell's Feedback to Forge entry: icon-only at phone width, named from `sm`. `clientVersion` is
 * the client and the version the page is served at (`web 0.4.0-dev.260`), which the shell reads.
 */
export function ForgeFeedbackButton({ clientVersion }: { clientVersion?: string | undefined }) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  const [filed, setFiled] = useState<ForgeFeedbackFiled | null>(null);
  const close = () => {
    setOpen(false);
    setFiled(null);
  };
  return (
    <>
      <Button type="button" variant="ghost" size="sm" icon="mail" aria-label={t("feedback.forge.open")} onClick={() => setOpen(true)} data-testid="forge-feedback-open">
        <span className="max-sm:sr-only">{t("feedback.forge.open")}</span>
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => (next ? setOpen(true) : close())}
        title={t("feedback.forge.title")}
        testId="forge-feedback-dialog"
      >
        {filed ? <ForgeFeedbackFiledNote filed={filed} onClose={close} /> : open ? <ForgeFeedbackForm clientVersion={clientVersion} onFiled={setFiled} onCancel={close} /> : null}
      </Dialog>
    </>
  );
}
