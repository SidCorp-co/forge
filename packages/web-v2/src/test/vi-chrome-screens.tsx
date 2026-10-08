import type { ReactElement } from "react";

// The screens the vi walking test renders, gathered from every `vi-chrome-*.tsx` beside this file:
// each exports `SCREENS`, a name and a function per screen returning it filled with placeholder data.
// A new screen goes in its area's file, or in a new `vi-chrome-<area>.tsx`; no shared list names it.

export interface ChromeScreen {
  name: string;
  render: () => ReactElement;
  /** What the screen opens once drawn (a menu, a popover), so the chrome inside it is read too. */
  act?: () => void;
}

declare global {
  interface ImportMeta {
    glob<T>(patterns: string | string[], options: { eager: true }): Record<string, T>;
  }
}

/** Every file's screens; a file registering none, or two screens sharing a name, is refused by name. */
export function gatherScreens(files: Record<string, { SCREENS?: ChromeScreen[] }>): ChromeScreen[] {
  const where = new Map<string, string>();
  const out: ChromeScreen[] = [];
  for (const [file, mod] of Object.entries(files)) {
    if (!mod.SCREENS?.length) throw new Error(`${file} registers no screen: a vi-chrome-*.tsx exports SCREENS, the screens it adds to the vi walking test.`);
    for (const screen of mod.SCREENS) {
      const before = where.get(screen.name);
      if (before) throw new Error(`The vi screen "${screen.name}" is registered by both ${before} and ${file}: a screen's name names one test.`);
      where.set(screen.name, file);
      out.push(screen);
    }
  }
  return out;
}

export const CHROME_SCREENS: ChromeScreen[] = gatherScreens(
  import.meta.glob<{ SCREENS?: ChromeScreen[] }>(["./vi-chrome-*.tsx", "!./vi-chrome-screens.tsx"], { eager: true }),
);
