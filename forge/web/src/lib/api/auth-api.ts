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

  refresh: (refreshToken: string) =>
    apiClient<RefreshResponse>('/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    }),
};
