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
  type WhatsNewSeenValue,
  whatsNewSeenValueSchema,
} from '@forge/contracts/product-state';
import type { ReleasePageRefusalCode } from '@forge/contracts/release-page';
import type { Refusal } from '../lib/refusal.js';
import type { ServingRead } from './ports.js';

function refusal(
  code: ProductStateRefusalCode | ReleasePageRefusalCode,
  detail: string,
  path = '/value',
): Refusal {
  return { code, path, detail };
}

/**
 * Why a What's new mark naming a release is refused: the instance declares no environment, or the
 * mark is for another environment, or for a release this instance does not serve (so a mark can
 * neither pretend a release was seen that is not here, nor be carried over from another instance).
 */
function releaseMarkRefusal(
  mark: { environment: string; version: string },
  serving: ServingRead,
): Refusal | null {
  if (serving.environment === null) {
    return refusal(
      'RELEASE_SEEN_ENVIRONMENT_UNKNOWN',
      'this instance declares no environment name (FORGE_ENVIRONMENT), so a release seen here cannot be counted against one',
      '/value/release/environment',
    );
  }
  if (mark.environment !== serving.environment) {
    return refusal(
      'RELEASE_SEEN_NOT_SERVING',
      `release ${mark.version} was seen in environment "${mark.environment}", but this instance is "${serving.environment}"`,
      '/value/release/environment',
    );
  }
  if (mark.version !== serving.version) {
    return refusal(
      'RELEASE_SEEN_NOT_SERVING',
      serving.version === null
        ? `this instance serves no release, so release ${mark.version} cannot have been seen here`
        : `this instance serves release ${serving.version}, not ${mark.version}`,
      '/value/release/version',
    );
  }
  return null;
}

/** Why `value` is not a value `key` holds, or null when it is. */
export async function productStateValueRefusal(
  key: ProductStateKey,
  value: unknown,
  now: Date,
  serving: () => Promise<ServingRead>,
): Promise<Refusal | null> {
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
  const mark = kind === 'whats_new_seen' ? (parsed.data as WhatsNewSeenValue).release : undefined;
  return mark ? releaseMarkRefusal(mark, await serving()) : null;
}
