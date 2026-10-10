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
import { usePreferences, useUpdatePreferences } from "@/features/preferences";
import { AssistantPreferencesCard } from "./assistant-preferences-card";
import type { LanguagePref, ThemePref } from "@/features/preferences";
import { useCopy } from "@/lib/i18n/interface-language";

const THEMES = ["system", "light", "dark"] as const;
// A language is named in its own words wherever the screen is read (`language.*` of the locale file).
// No choice reads as English: a project's content language never sets Forge's chrome (REQ-13 BC-2).
const DEFAULT_LANGUAGE: LanguagePref = "en";

export function AccountTab() {
  const { user } = useAuth();
  const t = useCopy();
  return (
    <div className="space-y-6">
      <PageSection>
        <PageSectionBody>
          <SectionTitle className="fg-h3 mb-4">{t("shell.account.profile")}</SectionTitle>
          <dl className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <dt className="fg-label">{t("shell.account.email")}</dt>
              <dd className="fg-body-sm text-fg">{user?.email ?? "—"}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="fg-label">{t("shell.account.userId")}</dt>
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
  const [language, setLanguage] = useState<LanguagePref>(DEFAULT_LANGUAGE);
  const t = useCopy();
  const themeOptions: SelectOption[] = THEMES.map((v) => ({ value: v, label: t(`shell.account.theme.${v}`) }));
  const languageOptions: SelectOption[] = [
    { value: "en", label: t("language.en") },
    { value: "vi", label: t("language.vi") },
  ];

  // Hydrate the local form once the server preferences load.
  useEffect(() => {
    if (prefsQ.data) {
      setTheme(prefsQ.data.theme);
      setLanguage(prefsQ.data.language ?? DEFAULT_LANGUAGE);
    }
  }, [prefsQ.data]);

  const dirty = !!prefsQ.data && (theme !== prefsQ.data.theme || language !== (prefsQ.data.language ?? DEFAULT_LANGUAGE));

  return (
    <PageSection>
      <PageSectionBody>
        <SectionTitle className="fg-h3 mb-4">{t("shell.account.preferences")}</SectionTitle>
        {prefsQ.isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-10 w-full rounded-md" />
            <Skeleton className="h-10 w-full rounded-md" />
          </div>
        ) : (
          <div className="space-y-4">
            <Field label={t("shell.account.theme")}>
              <Select
                options={themeOptions}
                value={theme}
                onChange={(v) => setTheme(v as ThemePref)}
              />
            </Field>
            <Field label={t("language.label")}>
              <Select
                options={languageOptions}
                value={language}
                onChange={(v) => setLanguage(v as LanguagePref)}
              />
            </Field>
            <div>
              <Button
                variant="primary"
                loading={update.isPending}
                disabled={!dirty}
                onClick={() => update.mutate({ theme, language })}
                className="min-h-11"
              >
                {t("shell.account.save")}
              </Button>
            </div>
          </div>
        )}
      </PageSectionBody>
    </PageSection>
  );
}
