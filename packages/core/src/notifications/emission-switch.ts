import type { NotificationType } from '../db/schema.js';
import { logger } from '../logger.js';

export const SUPPRESSED_TYPES: ReadonlySet<NotificationType> = new Set<NotificationType>([]);

export function emissionAllowed(type: NotificationType): boolean {
  return !SUPPRESSED_TYPES.has(type);
}

export function noteSuppressed(type: NotificationType, title: string): void {
  logger.info(
    { type, title, reason: 'ISS-1063 emission switch' },
    'notifications: suppressed by the emission switch — nobody is told, now or later',
  );
}
