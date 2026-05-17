import { apiClient } from '@/lib/api/client';

export type ReauthResponse = {
  freshAuthAt: string;
};

export const authApi = {
  reauth: (password: string) =>
    apiClient<ReauthResponse>('/auth/reauth', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
};
