"use client";

// Settings → Account. Identity is read from the hydrated auth session. Theme + language save
// against `/api/auth/me/preferences` and the reply style + standing instructions against
// `/api/auth/preferences`: two routes, one form, one save bar.
import { displayNameRefusal, personName } from "@forge/contracts/person-name";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import type { AnswerStyle } from "@forge/contracts";
import {
  Banner,
  Button,
  ErrorState,
  Field,
  Input,
  MonoTag,
  SectionTitle,
  Select,
  SettingsFormBar,
  Skeleton,
  type SelectOption,
  useSettingsForm,
  SettingsSection,
} from "@/design";
import { formatApiError, formatApiReason } from "@/lib/api/error";
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
  theme: ThemePref;
  language: LanguagePref;
  answerStyle: AnswerStyle;
  assistantInstructions: string;
}

const schema = z.object({
  theme: z.enum(["system", "light", "dark"]),
  language: z.enum(["en", "vi"]),
  answerStyle: z.enum(["default", "concise", "detailed", "bullets"]),
  assistantInstructions: z.string().max(2000, "Standing instructions are at most 2000 characters."),
}) as unknown as z.ZodType<AccountDraft, AccountDraft>;

const readOf = (prefs: Preferences, assistant: AssistantPreferences): AccountDraft => ({
  theme: prefs.theme,
  language: prefs.language,
  answerStyle: assistant.answerStyle,
  assistantInstructions: assistant.assistantInstructions ?? "",
});

/** Standing instructions of nothing but whitespace are no instructions: they are what a save clears. */
const blankAsEmpty = (value: string): string => (value.trim() === "" ? "" : value);

function AccountPreferences({
  prefs,
  assistant,
}: {
  prefs: Preferences;
  assistant: AssistantPreferences;
}) {
  const updatePrefs = useUpdatePreferences();
  const updateAssistant = useUpdateAssistantPreferences();
  const [failure, setFailure] = useState<string | null>(null);
  const form = useSettingsForm<AccountDraft>({
    read: readOf(prefs, assistant),
    schema,
    comparable: (d) => ({ ...d, assistantInstructions: blankAsEmpty(d.assistantInstructions) }),
  });
  const { theme, language } = form.draft;

  async function save() {
    setFailure(null);
    await form.save(async (held) => {
      const saved: string[] = [];
      try {
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
        saving={updatePrefs.isPending || updateAssistant.isPending}
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

/** The name other members read this person by (ISS-1229 r21): set here, cleared here. */
function DisplayNameField() {
  const { user, setDisplayName } = useAuth();
  const qc = useQueryClient();
  const saved = user?.displayName ?? "";
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const value = draft ?? saved;
  // The one sentence core refuses the same name with, shown before anything is sent (ISS-1229 r22).
  const refused = draft === null ? null : displayNameRefusal(draft);
  const save = async (next: string | null) => {
    setSaving(true);
    setFailure(null);
    try {
      await setDisplayName(next);
      setDraft(null);
      // The personal workspace follows the name, so the organization list is read again.
      await qc.invalidateQueries({ queryKey: ["orgs"] });
    } catch (err) {
      setFailure(formatApiError(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="space-y-2">
      <Field
        label="Display name"
        hint={`What other members read you as. Without one you read as "${personName(null, "start")}".`}
        error={refused ?? failure ?? undefined}
      >
        <Input
          value={value}
          maxLength={200}
          placeholder={personName(null, "start")}
          onChange={(e) => setDraft(e.target.value)}
        />
      </Field>
      <div className="flex justify-end gap-2">
        {saved && (
          <Button variant="ghost" size="sm" disabled={saving} onClick={() => void save(null)}>
            Clear
          </Button>
        )}
        <Button
          variant="primary"
          size="sm"
          loading={saving}
          disabled={!value.trim() || value.trim() === saved || refused !== null}
          onClick={() => void save(value.trim())}
        >
          Set name
        </Button>
      </div>
    </div>
  );
}

export function AccountTab() {
  const { user } = useAuth();
  const prefsQ = usePreferences();
  const assistantQ = useAssistantPreferences();

  return (
    <div className="space-y-6">
      <SettingsSection>
        <SectionTitle className="fg-h3 mb-4">Profile</SectionTitle>
        <DisplayNameField />
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
      </SettingsSection>

      {prefsQ.data && assistantQ.data ? (
        <AccountPreferences prefs={prefsQ.data} assistant={assistantQ.data} />
      ) : prefsQ.isError || assistantQ.isError ? (
        <SettingsSection>
          <ErrorState
            message={formatApiError(prefsQ.error ?? assistantQ.error)}
            onRetry={() => {
              void prefsQ.refetch();
              void assistantQ.refetch();
            }}
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
