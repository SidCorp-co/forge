"use client";

import { ThemeProvider as NextThemes } from "next-themes";

/* Light-only for now. The token system is dark-ready (see styles/tokens.css):
   adding dark = a [data-theme="dark"] override of the semantic layer + flip
   `forcedTheme` to enable the switch. We use `data-theme` (not `class`) so the
   tokens.css selector `[data-theme="dark"]` will Just Work later. */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemes
      attribute="data-theme"
      defaultTheme="light"
      forcedTheme="light"
      enableSystem={false}
    >
      {children}
    </NextThemes>
  );
}
