import { apiClient } from '@/lib/api/client';
import type { MePreferences, MeProfile } from './types';

export const meApi = {
  getProfile: () => apiClient<MeProfile>('/auth/me'),

  getPreferences: () => apiClient<MePreferences>('/auth/me/preferences'),

  updatePreferences: (
    patch: Partial<Pick<MePreferences, 'theme' | 'language' | 'lastSeenWhatsNew'>>,
  ) =>
    apiClient<MePreferences>('/auth/me/preferences', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
};
