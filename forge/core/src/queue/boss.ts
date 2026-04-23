import PgBoss from 'pg-boss';
import { env } from '../config/env.js';

export const boss = new PgBoss(env.DATABASE_URL);

let started = false;

export async function startBoss(): Promise<void> {
  if (started) return;
  await boss.start();
  started = true;
}

export async function stopBoss(): Promise<void> {
  if (!started) return;
  await boss.stop({ graceful: true });
  started = false;
}

export function isBossStarted(): boolean {
  return started;
}

export type Boss = typeof boss;
