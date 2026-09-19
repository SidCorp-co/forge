"use client";

// Settings → Account → how the assistant answers you. The style and the
// standing instructions save through the same preferences route as the theme;
// the trail underneath is every write anybody made to them, each restorable.
import { useEffect, useState } from "react";
import type { AnswerStyle, PreferenceChange } from "@forge/contracts";
import {
  Button,
  Card,
  CardContent,
  CardTitle,
  Field,
  SectionTitle,
  Select,
  Skeleton,
  Textarea,
  type SelectOption,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import {
  useAssistantPreferences,
  usePreferenceChanges,
  useRestorePreferenceChange,
  useUpdateAssistantPreferences,
} from "../hooks";

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

export function AssistantPreferencesCard() {
  const prefsQ = useAssistantPreferences();
  const changesQ = usePreferenceChanges();
  const update = useUpdateAssistantPreferences();
  const restore = useRestorePreferenceChange();
  const { toast } = useToast();

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

  async function onRestore(change: PreferenceChange) {
    try {
      await restore.mutateAsync(change.id);
      toast({ title: "Restored", description: describeChange(change), tone: "success" });
    } catch (err) {
      toast({ title: "Could not restore", description: formatApiError(err), tone: "error" });
    }
  }

  return (
    <Card>
      <CardContent>
        <SectionTitle className="fg-h3 mb-1">How the assistant answers you</SectionTitle>
        <p className="fg-body-sm mb-4 text-muted">
          Applies to every reply addressed to you — in Forge rooms and in every connected chat.
        </p>
        {prefsQ.isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-10 w-full rounded-md" />
            <Skeleton className="h-24 w-full rounded-md" />
          </div>
        ) : (
          <div className="space-y-4">
            <Field label="Reply style">
              <Select
                options={ANSWER_STYLE_OPTIONS}
                value={style}
                onChange={(v) => setStyle(v as AnswerStyle)}
              />
            </Field>
            <Field
              label="Standing instructions"
              hint="Followed in every reply to you. Leave empty for none."
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
                Save answer preferences
              </Button>
            </div>
          </div>
        )}

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
      </CardContent>
    </Card>
  );
}
