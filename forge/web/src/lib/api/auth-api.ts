import type {
  LoginInput,
  LoginResponse,
  RefreshResponse,
  RegisterInput,
  RegisterResponse,
  User,
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

  me: () => apiClient<User>('/auth/me'),

  logout: () => apiClient<void>('/auth/logout', { method: 'POST' }),

  /**
   * The refresh token now rides the httpOnly `forge_refresh` cookie. The
   * browser sends it automatically on this same-origin POST; client code
   * doesn't see it, doesn't pass it, and shouldn't try to.
   */
  refresh: () =>
    apiClient<RefreshResponse>('/auth/refresh', { method: 'POST' }),
};
