// Ported verbatim from `packages/web/src/lib/api/auth-api.ts` (ISS-288).
import type {
  LoginInput,
  LoginResponse,
  MeResponse,
  RefreshResponse,
  RegisterInput,
  RegisterResponse,
} from '@forge/contracts';
import { apiClient } from './client';

export const authApi = {
  login: (input: LoginInput) =>
    apiClient<LoginResponse>('/auth/local', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  register: (input: RegisterInput) =>
    apiClient<RegisterResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  me: () => apiClient<MeResponse>('/auth/me'),

  logout: () => apiClient<void>('/auth/logout', { method: 'POST' }),

  refresh: () =>
    apiClient<RefreshResponse>('/auth/refresh', { method: 'POST' }),
};
