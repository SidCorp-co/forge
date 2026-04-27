export interface MeProfile {
  id: string;
  email: string;
  emailVerifiedAt: string | null;
  isCeo: boolean;
  createdAt: string;
}

export type Theme = 'system' | 'light' | 'dark';
export type Language = 'en' | 'vi';

export interface MePreferences {
  theme: Theme;
  language: Language;
  updatedAt: string | null;
}
