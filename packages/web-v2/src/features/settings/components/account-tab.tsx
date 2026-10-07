"use client";

// Settings → Account. Identity is read from the hydrated auth session; theme +
// language preferences save against `/api/auth/me/preferences`.
import { useEffect, useState } from "react";
import {
  Button,
  PageSection,
  PageSectionBody,
  Field,
  MonoTag,
  SectionTitle,
  Select,
  Skeleton,
  type SelectOption,
} from "@/design";
import { useAuth } from "@/providers/auth-provider";
import { usePreferences, useUpdatePreferences } from "@/features/preferences/hooks";
import { AssistantPreferencesCard } from "./assistant-preferences-card";
import type { LanguagePref, ThemePref } from "@/features/preferences/types";
import { useCopy } from "@/lib/i18n/interface-language";

const THEME_OPTIONS: SelectOption[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];
// A language is named in its own words wherever the screen is read (`language.*` of the locale file).
const PROJECT_DEFAULT = "project";
type LanguageChoice = LanguagePref | typeof PROJECT_DEFAULT;

export function AccountTab() {
  const { user } = useAuth();
  return (
    <div className="space-y-6">
      <PageSection>
        <PageSectionBody>
          <SectionTitle className="fg-h3 mb-4">Profile</SectionTitle>
          <dl className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <dt className="fg-label">Email</dt>
              <dd className="fg-body-sm text-fg">{user?.email ?? "—"}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="fg-label">User ID</dt>
              <dd>{user?.id ? <MonoTag>{user.id}</MonoTag> : "—"}</dd>
            </div>
          </dl>
        </PageSectionBody>
      </PageSection>
      <PreferencesCard />
      <AssistantPreferencesCard />
    </div>
  );
}

function PreferencesCard() {
  const prefsQ = usePreferences();
  const update = useUpdatePreferences();
  const [theme, setTheme] = useState<ThemePref>("system");
  const [language, setLanguage] = useState<LanguageChoice>(PROJECT_DEFAULT);
  const t = useCopy();
  const languageOptions: SelectOption[] = [
    { value: PROJECT_DEFAULT, label: t("language.project") },
    { value: "en", label: t("language.en") },
    { value: "vi", label: t("language.vi") },
  ];

  // Hydrate the local form once the server preferences load.
  useEffect(() => {
    if (prefsQ.data) {
      setTheme(prefsQ.data.theme);
      setLanguage(prefsQ.data.language ?? PROJECT_DEFAULT);
    }
  }, [prefsQ.data]);

  const dirty = !!prefsQ.data && (theme !== prefsQ.data.theme || language !== (prefsQ.data.language ?? PROJECT_DEFAULT));

  return (
    <PageSection>
      <PageSectionBody>
        <SectionTitle className="fg-h3 mb-4">Preferences</SectionTitle>
        {prefsQ.isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-10 w-full rounded-md" />
            <Skeleton className="h-10 w-full rounded-md" />
          </div>
        ) : (
          <div className="space-y-4">
            <Field label="Theme" hint="Applies the next time the app loads.">
              <Select
                options={THEME_OPTIONS}
                value={theme}
                onChange={(v) => setTheme(v as ThemePref)}
              />
            </Field>
            <Field label={t("language.label")} hint={t("language.hint")}>
              <Select
                options={languageOptions}
                value={language}
                onChange={(v) => setLanguage(v as LanguageChoice)}
              />
            </Field>
            <div>
              <Button
                variant="primary"
                loading={update.isPending}
                disabled={!dirty}
                onClick={() => update.mutate({ theme, language: language === PROJECT_DEFAULT ? null : language })}
                className="min-h-11"
              >
                Save preferences
              </Button>
            </div>
          </div>
        )}
      </PageSectionBody>
    </PageSection>
  );
}
