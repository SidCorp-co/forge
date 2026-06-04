export interface MeProfile {
  id: string;
  email: string;
  emailVerifiedAt: string | null;
  createdAt: string;
  hasPassword: boolean;
  oauthProviders: string[];
  lastFreshAuthAt: string | null;
}

export type Theme = 'system' | 'light' | 'dark';
export type Language = 'en' | 'vi';

export interface MePreferences {
  theme: Theme;
  language: Language;
  /** Identity of the newest "What's New" entry the user has seen (changelog
   *  version or `unreleased:<hash>`); null until they first open the feed. */
  lastSeenWhatsNew: string | null;
  updatedAt: string | null;
}
