import { z } from 'zod';
import { type ModelTier, modelTiers } from '../db/schema.js';

/** The tiers a caller may ask for — the `model_tier` DB enum, not a copy of it. */
export const modelTierSchema = z.enum(modelTiers);

export const sessionModelSchema = z.union([modelTierSchema, z.literal('default')]);

export type SessionModel = ModelTier | 'default';

export function readSessionModel(metadata: unknown): SessionModel | null {
  const value = (metadata as { model?: unknown } | null | undefined)?.model;
  const parsed = sessionModelSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
