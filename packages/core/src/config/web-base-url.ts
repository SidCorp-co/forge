import { env } from './env.js';

let cached: string | undefined;
let read = false;

/** The web app's origin, the first of `CORS_ORIGINS`, for links a message carries back to Forge. */
export function webBaseUrl(): string | undefined {
  if (!read) {
    cached = env.CORS_ORIGINS.split(',')[0]?.trim().replace(/\/+$/, '') || undefined;
    read = true;
  }
  return cached;
}
