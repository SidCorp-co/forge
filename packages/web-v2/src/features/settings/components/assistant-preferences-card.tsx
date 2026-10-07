"use client";

// Settings → Account → how the assistant answers you. The style and the
// standing instructions save through the same preferences route as the theme;
// the trail underneath is every write anybody made to them, each restorable.
import { useEffect, useState } from "react";
import type { AnswerStyle, PreferenceChange } from "@forge/contracts/assistant-self";
import {
  Button,
  PageSection,
  PageSectionBody,
  PageSectionTitle,
  Field,
  SectionTitle,
  Select,
  Skeleton,
  Textarea,
  type SelectOption,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";
import { useToast } from "@/providers/toast-provider";
import {
  useAssistantPreferences,
  usePreferenceChanges,
  useRestorePreferenceChange,
  useUpdateAssistantPreferences,
} from "../hooks";

const ANSWER_STYLES = ["default", "concise", "detailed", "bullets"] as const;

const FIELD_LABEL: Record<PreferenceChange["field"], ProductCopyKey> = {
  answer_style: "shell.assistant.style",
  assistant_instructions: "shell.assistant.instructions",
};
const ACTOR_LABEL: Record<PreferenceChange["changedBy"], ProductCopyKey> = {
  person: "shell.assistant.byYou",
  assistant: "shell.assistant.byAssistant",
};

/** One row of the trail, as a sentence a person can act on; the value itself is what was written. */
function describeChange(change: PreferenceChange, t: Copy): string {
  const field = t(FIELD_LABEL[change.field]);
  const by = t(ACTOR_LABEL[change.changedBy]);
  return change.newValue === null || change.newValue === ""
    ? t("shell.assistant.cleared", { field, by })
    : t("shell.assistant.set", { field, value: change.newValue, by });
}

export function AssistantPreferencesCard() {
  const prefsQ = useAssistantPreferences();
  const update = useUpdateAssistantPreferences();
  const t = useCopy();
  const styleOptions: SelectOption[] = ANSWER_STYLES.map((v) => ({ value: v, label: t(`shell.assistant.style.${v}`) }));

  const [style, setStyle] = useState<AnswerStyle>("default");
  const [instructions, setInstructions] = useState("");
  useEffect(() => {
    if (prefsQ.data) {
      setStyle(prefsQ.data.answerStyle);
      setInstructions(prefsQ.data.assistantInstructions ?? "");
    }
  }, [prefsQ.data]);

  const dirty =
    !!prefsQ.data &&
    (style !== prefsQ.data.answerStyle ||
      instructions !== (prefsQ.data.assistantInstructions ?? ""));

  return (
    <PageSection>
      <PageSectionBody>
        <SectionTitle className="fg-h3 mb-1">{t("shell.assistant.title")}</SectionTitle>
        <p className="fg-body-sm mb-4 text-muted">{t("shell.assistant.lead")}</p>
        {prefsQ.isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-10 w-full rounded-md" />
            <Skeleton className="h-24 w-full rounded-md" />
          </div>
        ) : (
          <div className="space-y-4">
            <Field label={t("shell.assistant.style")}>
              <Select
                options={styleOptions}
                value={style}
                onChange={(v) => setStyle(v as AnswerStyle)}
              />
            </Field>
            <Field
              label={t("shell.assistant.instructions")}
              hint={t("shell.assistant.instructionsHint")}
            >
              <Textarea
                value={instructions}
                maxLength={2000}
                onChange={(e) => setInstructions(e.target.value)}
              />
            </Field>
            <div>
              <Button
                variant="primary"
                loading={update.isPending}
                disabled={!dirty}
                className="min-h-11"
                onClick={() =>
                  update.mutate({
                    answerStyle: style,
                    assistantInstructions: instructions.trim() === "" ? null : instructions,
                  })
                }
              >
                {t("shell.assistant.save")}
              </Button>
            </div>
          </div>
        )}

        <ChangeTrail />
      </PageSectionBody>
    </PageSection>
  );
}

/** Every write anybody made to these preferences, each restorable. */
function ChangeTrail() {
  const changesQ = usePreferenceChanges();
  const restore = useRestorePreferenceChange();
  const { toast } = useToast();
  const t = useCopy();
  const time = useTimeFormat();

  async function onRestore(change: PreferenceChange) {
    try {
      await restore.mutateAsync(change.id);
      toast({ title: t("shell.assistant.restored"), description: describeChange(change, t), tone: "success" });
    } catch (err) {
      toast({ title: t("shell.assistant.restoreFailed"), description: formatApiError(err), tone: "error" });
    }
  }

  return (
    <>
      <PageSectionTitle className="mt-8 mb-2">{t("shell.assistant.changes")}</PageSectionTitle>
      {changesQ.isLoading ? (
        <Skeleton className="h-10 w-full rounded-md" />
      ) : !changesQ.data || changesQ.data.length === 0 ? (
        <p className="fg-body-sm text-muted">{t("shell.assistant.noChanges")}</p>
      ) : (
        <ul className="divide-y divide-line" data-testid="preference-changes">
          {changesQ.data.map((change) => (
            <li key={change.id} className="flex items-center justify-between gap-3 py-2">
              <div>
                <p className="fg-body-sm">{describeChange(change, t)}</p>
                <p className="fg-caption text-subtle">{time.dateTime(change.changedAt)}</p>
              </div>
              <Button
                variant="ghost"
                disabled={restore.isPending}
                onClick={() => onRestore(change)}
                aria-label={t("shell.assistant.restoreLabel", { change: describeChange(change, t) })}
              >
                {t("shell.assistant.restore")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
