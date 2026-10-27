"use client";

import type { AnswerStyle } from "@forge/contracts";
// Settings → Account. Identity is read from the hydrated auth session. The display name saves
// against `/api/auth/me`, theme + language against `/api/auth/me/preferences` and the reply style +
// standing instructions against `/api/auth/preferences`: three routes, one form, one save bar, so a
// typed name is an unsaved change like any other (ISS-1229 r23).
import { displayNameRefusal, personName } from "@forge/contracts/person-name";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import {
  Banner,
  Button,
  ErrorState,
  Field,
  Input,
  MonoTag,
  SectionTitle,
  Select,
  type SelectOption,
  SettingsFormBar,
  SettingsSection,
  Skeleton,
  useSettingsForm,
} from "@/design";
import { formatApiError, formatApiReason } from "@/lib/api/error";
import { retryFailedReads } from "@/lib/utils/retry-rule";
import { useAuth } from "@/providers/auth-provider";
import {
  useAssistantPreferences,
  usePreferences,
  useUpdateAssistantPreferences,
  useUpdatePreferences,
} from "../hooks";
import type { AssistantPreferences, LanguagePref, Preferences, ThemePref } from "../types";
import { AssistantPreferencesCard } from "./assistant-preferences-card";

const THEME_OPTIONS: SelectOption[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];
const LANGUAGE_OPTIONS: SelectOption[] = [
  { value: "en", label: "English" },
  { value: "vi", label: "Tiếng Việt" },
];

export interface AccountDraft {
  displayName: string;
  theme: ThemePref;
  language: LanguagePref;
  answerStyle: AnswerStyle;
  assistantInstructions: string;
}

const schema = z.object({
  // The one sentence core refuses the same name with, shown before anything is sent (ISS-1229 r22).
  displayName: z
    .string()
    .max(200)
    .superRefine((name, ctx) => {
      const refused = displayNameRefusal(name);
      if (refused) ctx.addIssue({ code: "custom", message: refused });
    }),
  theme: z.enum(["system", "light", "dark"]),
  language: z.enum(["en", "vi"]),
  answerStyle: z.enum(["default", "concise", "detailed", "bullets"]),
  assistantInstructions: z.string().max(2000, "Standing instructions are at most 2000 characters."),
}) as unknown as z.ZodType<AccountDraft, AccountDraft>;

const readOf = (
  savedName: string,
  prefs: Preferences,
  assistant: AssistantPreferences,
): AccountDraft => ({
  displayName: savedName,
  theme: prefs.theme,
  language: prefs.language,
  answerStyle: assistant.answerStyle,
  assistantInstructions: assistant.assistantInstructions ?? "",
});

/** Standing instructions of nothing but whitespace are no instructions: they are what a save clears. */
const blankAsEmpty = (value: string): string => (value.trim() === "" ? "" : value);

function AccountForm({
  prefs,
  assistant,
}: {
  prefs: Preferences;
  assistant: AssistantPreferences;
}) {
  const { user, setDisplayName } = useAuth();
  const qc = useQueryClient();
  const savedName = user?.displayName ?? "";
  const updatePrefs = useUpdatePreferences();
  const updateAssistant = useUpdateAssistantPreferences();
  const [failure, setFailure] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);
  const form = useSettingsForm<AccountDraft>({
    read: readOf(savedName, prefs, assistant),
    schema,
    comparable: (d) => ({
      ...d,
      displayName: d.displayName.trim(),
      assistantInstructions: blankAsEmpty(d.assistantInstructions),
    }),
  });
  const { theme, language } = form.draft;

  async function save() {
    setFailure(null);
    await form.save(async (held) => {
      const saved: string[] = [];
      try {
        const name = held.displayName.trim();
        if (name !== savedName.trim()) {
          setSavingName(true);
          try {
            await setDisplayName(name === "" ? null : name);
          } finally {
            setSavingName(false);
          }
          // The field shows the name as stored, without the spaces a save trims.
          form.setDraft((d) => ({ ...d, displayName: name }));
          saved.push("Display name");
          // The personal workspace follows the name, so the organization list is read again.
          await qc.invalidateQueries({ queryKey: ["orgs"] });
        }
        if (held.theme !== prefs.theme || held.language !== prefs.language) {
          await updatePrefs.mutateAsync({ theme: held.theme, language: held.language });
          saved.push("Theme and language");
        }
        if (
          held.answerStyle !== assistant.answerStyle ||
          blankAsEmpty(held.assistantInstructions) !== blankAsEmpty(assistant.assistantInstructions ?? "")
        ) {
          await updateAssistant.mutateAsync({
            answerStyle: held.answerStyle,
            assistantInstructions: blankAsEmpty(held.assistantInstructions) || null,
          });
        }
      } catch (err) {
        setFailure(
          `${saved.length > 0 ? `${saved.join(" and ")} saved, but not the rest.` : "Nothing was saved."} ${formatApiReason(err)} Your other edits are still here — Save sends them again.`,
        );
        throw err;
      }
    });
  }

  return (
    <>
      <SettingsSection>
        <SectionTitle className="fg-h3 mb-4">Profile</SectionTitle>
        <DisplayNameField
          value={form.draft.displayName ?? ""}
          error={form.errorAt("displayName")}
          onChange={(displayName) => form.setDraft((d) => ({ ...d, displayName }))}
        />
        <ProfileFacts />
      </SettingsSection>

      <SettingsSection>
        <SectionTitle className="fg-h3 mb-4">Preferences</SectionTitle>
        <div className="space-y-4">
          <Field label="Theme" hint="Applies the next time the app loads.">
            <Select
              options={THEME_OPTIONS}
              value={theme}
              onChange={(v) => form.setDraft((d) => ({ ...d, theme: v as ThemePref }))}
            />
          </Field>
          <Field label="Language">
            <Select
              options={LANGUAGE_OPTIONS}
              value={language}
              onChange={(v) => form.setDraft((d) => ({ ...d, language: v as LanguagePref }))}
            />
          </Field>
        </div>
      </SettingsSection>

      <AssistantPreferencesCard form={form} />

      <SettingsFormBar
        dirty={form.dirty}
        saving={savingName || updatePrefs.isPending || updateAssistant.isPending}
        blockedBy={form.invalid ? "Fix what is marked above before saving." : null}
        onSave={() => void save().catch(() => undefined)}
        onDiscard={() => {
          setFailure(null);
          form.discard();
        }}
      >
        {failure && (
          <Banner tone="danger" onDismiss={() => setFailure(null)}>
            {failure}
          </Banner>
        )}
      </SettingsFormBar>
    </>
  );
}

/**
 * The name other members read this person by (ISS-1229 r21), a field of the page's one form: a draft
 * that differs from the saved name is an unsaved change, and Clear empties the field, never the
 * saved name, which only Save writes (ISS-1229 r23).
 */
function DisplayNameField({
  value,
  error,
  onChange,
}: {
  value: string;
  error: string | undefined;
  onChange: (next: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Field
        label="Display name"
        hint={`What other members read you as. Without one you read as "${personName(null, "start")}".`}
        error={error}
      >
        <Input
          value={value}
          maxLength={200}
          placeholder={personName(null, "start")}
          onChange={(e) => onChange(e.target.value)}
        />
      </Field>
      {value !== "" && (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => onChange("")}>
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}

function ProfileFacts() {
  const { user } = useAuth();
  return (
    <dl className="mt-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <dt className="fg-label">Email</dt>
        <dd className="fg-body-sm text-fg">{user?.email ?? "—"}</dd>
      </div>
      <div className="flex items-center justify-between gap-3">
        <dt className="fg-label">User ID</dt>
        <dd>{user?.id ? <MonoTag>{user.id}</MonoTag> : "—"}</dd>
      </div>
    </dl>
  );
}

export function AccountTab() {
  const prefsQ = usePreferences();
  const assistantQ = useAssistantPreferences();

  if (prefsQ.data && assistantQ.data) {
    return (
      <div className="space-y-6">
        <AccountForm prefs={prefsQ.data} assistant={assistantQ.data} />
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <SettingsSection>
        <SectionTitle className="fg-h3 mb-4">Profile</SectionTitle>
        <ProfileFacts />
      </SettingsSection>
      {prefsQ.isError || assistantQ.isError ? (
        <SettingsSection>
          <ErrorState title="Couldn't load your preferences"
            message={formatApiError(prefsQ.error ?? assistantQ.error)}
            {...retryFailedReads([
              { failed: prefsQ.isError, error: prefsQ.error, retry: () => void prefsQ.refetch() },
              { failed: assistantQ.isError, error: assistantQ.error, retry: () => void assistantQ.refetch() },
            ])}
          />
        </SettingsSection>
      ) : (
        <SettingsSection>
          <SectionTitle className="fg-h3 mb-4">Preferences</SectionTitle>
          <div className="space-y-4">
            <Skeleton className="h-10 w-full rounded-md" />
            <Skeleton className="h-10 w-full rounded-md" />
          </div>
        </SettingsSection>
      )}
    </div>
  );
}
