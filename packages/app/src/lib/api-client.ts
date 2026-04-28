import * as SecureStore from 'expo-secure-store';
import { toByteArray } from 'base64-js';
import { API_URL } from './constants';

const API_ORIGIN = API_URL.replace(/\/api\/?$/, '');

export function mediaUrl(url: string): string {
  if (url.startsWith('http')) return url;
  return `${API_ORIGIN}${url}`;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  let base64 = token.split('.')[1]
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  const bytes = toByteArray(base64);
  const json = String.fromCharCode(...bytes);
  return JSON.parse(json);
}

function isTokenExpired(token: string): boolean {
  try {
    const payload = decodeJwtPayload(token);
    return (payload.exp as number) * 1000 < Date.now();
  } catch {
    return true;
  }
}

export async function apiClient<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const raw = await SecureStore.getItemAsync('jwt');
  const token = raw && !isTokenExpired(raw) ? raw : null;

  const res = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...options.headers,
    },
  });

  if (!res.ok) {
    throw new ApiError(res.status, await res.text());
  }

  return res.json();
}

export async function apiUpload(formData: FormData): Promise<{ id: number; url: string; name: string }[]> {
  const raw = await SecureStore.getItemAsync('jwt');
  const token = raw && !isTokenExpired(raw) ? raw : null;

  const res = await fetch(`${API_URL}/upload`, {
    method: 'POST',
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: formData,
  });

  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json();
}
