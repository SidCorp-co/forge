const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:1337/api';

/** Strapi base URL (without /api) for resolving relative media URLs like /uploads/... */
const STRAPI_URL = API_URL.replace(/\/api\/?$/, '');

/** WebSocket URL derived from NEXT_PUBLIC_WS_URL or the API URL. */
export const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ||
  STRAPI_URL.replace(/^http/, 'ws') + '/ws';

/** Resolve a Strapi media URL — returns absolute URL for both relative and absolute inputs. */
export function strapiMediaUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return `${STRAPI_URL}${url}`;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

function isTokenExpired(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.exp * 1000 < Date.now();
  } catch {
    return true;
  }
}

// Note: localStorage is used for simplicity; httpOnly cookies recommended for production
export async function apiClient<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const raw = typeof window !== 'undefined' ? localStorage.getItem('jwt') : null;
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

/** Upload files via Strapi's upload endpoint. Returns parsed JSON response. */
export async function apiUpload(formData: FormData): Promise<any> {
  const raw = typeof window !== 'undefined' ? localStorage.getItem('jwt') : null;
  const token = raw && !isTokenExpired(raw) ? raw : null;

  const res = await fetch(`${API_URL}/upload`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  });

  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json();
}
