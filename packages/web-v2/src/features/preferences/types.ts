export type ThemePref = "system" | "light" | "dark";
export type LanguagePref = "en" | "vi";

export interface Preferences {
  theme: ThemePref;
  /** The interface language the person chose; null reads English (REQ-13 BC-2). */
  language: LanguagePref | null;
  notifyOnMention: boolean;
  /** The org the user is currently "working in" (ISS-469 global org switcher);
   *  null = no explicit choice (client resolves to the personal org). */
  activeOrgId: string | null;
  updatedAt: string | null;
}
