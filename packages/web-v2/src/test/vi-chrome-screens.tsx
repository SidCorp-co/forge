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

/**
 * Every file's screens; a file registering none, or two screens sharing a name, is refused by name.
 * Each file's `SCREENS` export arrives untyped and is checked here: tsgo resolves `import.meta.glob`'s
 * overloads differently from run to run, so a type argument at the call fails some runs and not others.
 */
function gatherScreens(files: Record<string, unknown>): ChromeScreen[] {
  const where = new Map<string, string>();
  const out: ChromeScreen[] = [];
  for (const [file, screens] of Object.entries(files)) {
    if (!Array.isArray(screens) || screens.length === 0) throw new Error(`${file} registers no screen: a vi-chrome-*.tsx exports SCREENS, the screens it adds to the vi walking test.`);
    for (const screen of screens as ChromeScreen[]) {
      const before = where.get(screen.name);
      if (before) throw new Error(`The vi screen "${screen.name}" is registered by both ${before} and ${file}: a screen's name names one test.`);
      where.set(screen.name, file);
      out.push(screen);
    }
  }
  return out;
}

export const CHROME_SCREENS: ChromeScreen[] = gatherScreens(
  import.meta.glob(["./vi-chrome-*.tsx", "!./vi-chrome-screens.tsx"], { eager: true, import: "SCREENS" }),
);
