
import { ThemeProvider as NextThemes, useTheme } from "next-themes";
import { useEffect } from "react";
import { usePreferences } from "@/features/preferences/hooks";
import { useAuth } from "@/providers/auth-provider";

// Light and dark are both complete (tokens v2, styles/tokens.css): the theme follows the system until
// the person picks one in Account › Preferences, and their pick applies at once on every device.
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemes attribute="data-theme" defaultTheme="system" enableSystem disableTransitionOnChange>
      {children}
    </NextThemes>
  );
}

function FollowPreference() {
  const pref = usePreferences().data?.theme;
  const { setTheme } = useTheme();
  useEffect(() => {
    if (pref) setTheme(pref);
  }, [pref, setTheme]);
  return null;
}

/** Applies the signed-in person's kept theme; signed out, the system's stands. */
export function ThemeSync() {
  const { user } = useAuth();
  return user ? <FollowPreference /> : null;
}
