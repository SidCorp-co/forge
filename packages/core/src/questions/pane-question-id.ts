import { createHash } from 'node:crypto';
import { DIALOG_QUESTIONS_MAX } from '../jobs/blocked-wire.js';

/** The same id for the same blocked job and place, in the shape of a name-based (v5) uuid. */
export function questionIdFor(jobId: string, index: number): string {
  const bytes = Buffer.from(
    createHash('sha1').update(`forge:blocked-question:${jobId}:${index}`).digest().subarray(0, 16),
  );
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Every id a blocked job's questions can take, one per place in its dialog. */
export function questionIdsFor(jobId: string): string[] {
  return Array.from({ length: DIALOG_QUESTIONS_MAX }, (_, i) => questionIdFor(jobId, i));
}
