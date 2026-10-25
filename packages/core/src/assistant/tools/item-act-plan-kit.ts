// What every item kind's plan answers, and the helpers each adapter of `item-act-plans.ts:planItemAct`
// shares: a refusal by code, an offer, a read that found nothing.

import type { ItemActOffer, ItemActRefusalCode } from '@forge/contracts/item-acts';
import { HTTPException } from 'hono/http-exception';

/** What a card presses, less what the tool adds from the call itself. */
export type ItemActPlan = Pick<ItemActOffer, 'key' | 'ref' | 'title' | 'from'> &
  Partial<Pick<ItemActOffer, 'revision' | 'runId' | 'approvalId' | 'issueIds' | 'issueKeys'>>;

export interface ItemActRefused {
  code: ItemActRefusalCode;
  /** What the model reads. */
  why: string;
}

export type ItemActReading =
  | { ok: true; plan: ItemActPlan }
  | { ok: false; refused: ItemActRefused };

export interface Asker {
  projectId: string;
  userId: string;
}

export const no = (code: ItemActRefusalCode, why: string): ItemActReading => ({
  ok: false,
  refused: { code, why },
});
export const offer = (plan: ItemActPlan): ItemActReading => ({ ok: true, plan });

/** A read that answered "no such item here" (404, or a key of the wrong shape); anything else is thrown on. */
export async function found<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read;
  } catch (err) {
    if (err instanceof HTTPException && (err.status === 404 || err.status === 400)) return null;
    throw err;
  }
}

export const unknown = (kind: string, key: string) =>
  no('ITEM_ACT_UNKNOWN_ITEM', `${key} names no ${kind} in this project.`);
