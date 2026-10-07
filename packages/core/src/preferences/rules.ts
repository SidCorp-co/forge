/**
 * A person's product state (`user_product_state`) holds a closed key namespace
 * (`@forge/contracts/product-state:productStateKeyKind`), each family's value in one shape; a value
 * outside it is refused by name and nothing is written.
 */

import {
  PRODUCT_STATE_VALUE_SHAPES,
  type ProductStateKey,
  type ProductStateRefusalCode,
  productStateKeyKind,
  SEEN_AT_SKEW_MS,
  tourStateValueSchema,
  whatsNewSeenValueSchema,
} from '@forge/contracts/product-state';
import type { Refusal } from '../lib/refusal.js';

function refusal(code: ProductStateRefusalCode, detail: string, path = '/value'): Refusal {
  return { code, path, detail };
}

/** Why `value` is not a value `key` holds, or null when it is. */
export function productStateValueRefusal(
  key: ProductStateKey,
  value: unknown,
  now: Date,
): Refusal | null {
  const kind = productStateKeyKind(key);
  if (kind === null) {
    return refusal('PRODUCT_STATE_KEY_UNKNOWN', `${key} is not a product state key`, '');
  }
  const schema = kind === 'tour' ? tourStateValueSchema : whatsNewSeenValueSchema;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const why = parsed.error.issues.map((i) => i.message).join('; ');
    return refusal(
      'PRODUCT_STATE_VALUE_INVALID',
      `${key} holds ${PRODUCT_STATE_VALUE_SHAPES[kind]}: ${why}`,
    );
  }
  const at = Date.parse(parsed.data.at);
  if (at > now.getTime() + SEEN_AT_SKEW_MS) {
    return refusal(
      'PRODUCT_STATE_VALUE_INVALID',
      `${key} at ${parsed.data.at} is later than now (${now.toISOString()}); a mark records a moment that has happened`,
      '/value/at',
    );
  }
  return null;
}
