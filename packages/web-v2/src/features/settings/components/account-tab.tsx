"use client";

// Settings → Account. Identity is read from the hydrated auth session; theme +
// language preferences save against `/api/auth/me/preferences`.
import { useEffect, useState } from "react";
import {
  Button,
  Card,
  CardContent,
  Field,
  MonoTag,
  Select,
  Skeleton,
  type SelectOption,
} from "@/design";
import { useAuth } from "@/providers/auth-provider";
import { usePreferences, useUpdatePreferences } from "../hooks";
import type { LanguagePref, ThemePref } from "../types";

const THEME_OPTIONS: SelectOption[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];
const LANGUAGE_OPTIONS: SelectOption[] = [
  { value: "en", label: "English" },
  { value: "vi", label: "Tiếng Việt" },
];

export function AccountTab() {
  const { user } = useAuth();
  const prefsQ = usePreferences();
  const update = useUpdatePreferences();

  const [theme, setTheme] = useState<ThemePref>("system");
  const [language, setLanguage] = useState<LanguagePref>("en");

  // Hydrate the local form once the server preferences load.
  useEffect(() => {
    if (prefsQ.data) {
      setTheme(prefsQ.data.theme);
      setLanguage(prefsQ.data.language);
    }
  }, [prefsQ.data]);

  const dirty =
    !!prefsQ.data && (theme !== prefsQ.data.theme || language !== prefsQ.data.language);

  return (
    <div className="space-y-6">
      <Card>
        <CardContent>
          <h2 className="fg-h3 mb-4">Profile</h2>
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
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <h2 className="fg-h3 mb-4">Preferences</h2>
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
              <Field label="Language">
                <Select
                  options={LANGUAGE_OPTIONS}
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
                  Save preferences
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
