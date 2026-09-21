"use client";

import { ThemeProvider as NextThemes } from "next-themes";

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
