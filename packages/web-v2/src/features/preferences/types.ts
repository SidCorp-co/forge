export type ThemePref = "system" | "light" | "dark";
export type LanguagePref = "en" | "vi";

export interface Preferences {
  theme: ThemePref;
  language: LanguagePref;
  notifyOnMention: boolean;
  /** The org the user is currently "working in" (ISS-469 global org switcher);
   *  null = no explicit choice (client resolves to the personal org). */
  activeOrgId: string | null;
  updatedAt: string | null;
}
