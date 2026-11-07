
// Settings → Account. Identity is read from the hydrated auth session; the theme saves against
// `/api/auth/me/preferences`. Forge is English only (owner, 2026-10-08), so no language is chosen here
// (ISS-1071); a language a person chose before stays on their preferences, where core still reads it
// for what it writes to them, and never turns the chrome.
import { useState } from "react";
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
import { AssistantPreferences } from "./assistant-preferences-card";
import type { ThemePref } from "@/features/preferences";
import { useCopy } from "@/lib/i18n/interface-language";

const THEMES = ["system", "light", "dark"] as const;

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
      <AccountPreferences />
      <AssistantPreferences />
    </div>
  );
}

function AccountPreferences() {
  const prefsQ = usePreferences();
  const update = useUpdatePreferences();
  const [themeEdit, setThemeEdit] = useState<ThemePref | null>(null);
  const theme = themeEdit ?? prefsQ.data?.theme ?? "system";
  const t = useCopy();
  const themeOptions: SelectOption[] = THEMES.map((v) => ({ value: v, label: t(`shell.account.theme.${v}`) }));
  const dirty = !!prefsQ.data && theme !== prefsQ.data.theme;

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
                onChange={(v) => setThemeEdit(v as ThemePref)}
              />
            </Field>
            <div>
              <Button
                variant="primary"
                loading={update.isPending}
                disabled={!dirty}
                onClick={() => update.mutate({ theme })}
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
