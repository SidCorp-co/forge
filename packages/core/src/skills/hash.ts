import { createHash } from 'node:crypto';

export function hashSkillBody(skillMd: string, files: unknown): string {
  const payload = JSON.stringify({ skillMd, files: files ?? [] });
  return createHash('sha256').update(payload).digest('hex');
}
