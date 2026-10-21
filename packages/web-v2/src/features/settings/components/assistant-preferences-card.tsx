"use client";

// Settings → Account → how the assistant answers you. The style and the
// standing instructions save through the same preferences route as the theme;
// the trail underneath is every write anybody made to them, each restorable.
import type { AnswerStyle, PreferenceChange } from "@forge/contracts";
import {
  Button,
  CardTitle,
  Field,
  SectionTitle,
  Select,
  type SettingsForm,
  Skeleton,
  Textarea,
  type SelectOption,
  SettingsSection,
} from "@/design";
import { useToast } from "@/providers/toast-provider";
import { usePreferenceChanges, useRestorePreferenceChange } from "../hooks";
import type { AccountDraft } from "./account-tab";
import { failureToast } from "@/lib/api/failure-toast";

export const ANSWER_STYLE_OPTIONS: SelectOption[] = [
  { value: "default", label: "Default — let the assistant judge" },
  { value: "concise", label: "Concise — as few sentences as the question needs" },
  { value: "detailed", label: "Detailed — context, evidence and reasoning" },
  { value: "bullets", label: "Bullets — one point per line" },
];

const FIELD_LABEL: Record<PreferenceChange["field"], string> = {
  answer_style: "Reply style",
  assistant_instructions: "Standing instructions",
};
const ACTOR_LABEL: Record<PreferenceChange["changedBy"], string> = {
  person: "you",
  admin: "an org admin",
  assistant: "the assistant, in a conversation",
};

/** One row of the trail, as a sentence a person can act on. */
export function describeChange(change: PreferenceChange): string {
  const value = change.newValue === null || change.newValue === "" ? "cleared" : `set to “${change.newValue}”`;
  return `${FIELD_LABEL[change.field]} ${value} by ${ACTOR_LABEL[change.changedBy]}`;
}

export function AssistantPreferencesCard({ form }: { form: SettingsForm<AccountDraft> }) {
  const changesQ = usePreferenceChanges();
  const restore = useRestorePreferenceChange();
  const { toast } = useToast();
  const { answerStyle, assistantInstructions } = form.draft;

  async function onRestore(change: PreferenceChange) {
    try {
      await restore.mutateAsync(change.id);
      toast({ title: "Restored", description: describeChange(change), tone: "success" });
    } catch (err) {
      toast(failureToast(err, "Nothing was restored"));
    }
  }

  return (
    <SettingsSection>
      <SectionTitle className="fg-h3 mb-1">How the assistant answers you</SectionTitle>
      <p className="fg-body-sm mb-4 text-muted">
        Applies to every reply addressed to you — in Forge rooms and in every connected chat.
      </p>
      <div className="space-y-4">
        <Field label="Reply style">
          <Select
            options={ANSWER_STYLE_OPTIONS}
            value={answerStyle}
            onChange={(v) => form.setDraft((d) => ({ ...d, answerStyle: v as AnswerStyle }))}
          />
        </Field>
        <Field
          label="Standing instructions"
          hint="Followed in every reply to you. Leave empty for none."
          error={form.errorAt("assistantInstructions")}
        >
          <Textarea
            value={assistantInstructions}
            maxLength={2000}
            onChange={(e) =>
              form.setDraft((d) => ({ ...d, assistantInstructions: e.target.value }))
            }
          />
        </Field>
      </div>

      <CardTitle className="mt-8 mb-2">Changes</CardTitle>
      {changesQ.isLoading ? (
        <Skeleton className="h-10 w-full rounded-md" />
      ) : !changesQ.data || changesQ.data.length === 0 ? (
        <p className="fg-body-sm text-muted">Nothing has been changed yet.</p>
      ) : (
        <ul className="divide-y divide-line" data-testid="preference-changes">
          {changesQ.data.map((change) => (
            <li key={change.id} className="flex items-center justify-between gap-3 py-2">
              <div>
                <p className="fg-body-sm">{describeChange(change)}</p>
                <p className="fg-caption text-subtle">
                  {new Date(change.changedAt).toLocaleString()}
                </p>
              </div>
              <Button
                variant="ghost"
                disabled={restore.isPending}
                onClick={() => onRestore(change)}
                aria-label={`Restore: ${describeChange(change)}`}
              >
                Restore
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}
