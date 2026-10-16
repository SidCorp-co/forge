import { randomBytes } from 'node:crypto';
import { WIDGET_SITE_KEY_PATTERN, WIDGET_SITE_KEY_PREFIX } from '@forge/contracts/widget';
import { type BindingTargetRefusal, findBindingIdByConfigValue } from '../index.js';

/** A fresh site key: the contract's prefix and 24 random bytes as 32 base64url characters. */
export function mintSiteKey(): string {
  return `${WIDGET_SITE_KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
}

type Settled =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; refusals: BindingTargetRefusal[] };

const refused = (code: BindingTargetRefusal['code'], detail: string): Settled => ({
  ok: false,
  refusals: [{ code, path: '/siteKey', detail }],
});

/**
 * The site key a widget binding is stored with. A new binding takes the key its document names —
 * the settings page mints one in the browser, to show the embed snippet before saving — or one
 * minted here when it names none; after that the key never changes, since every page that embeds
 * the widget carries it. A key another binding holds, switched on or off, is refused by name.
 */
export async function settleSiteKey(args: {
  bindingId: string;
  config: Record<string, unknown>;
  held: Record<string, unknown> | null;
}): Promise<Settled> {
  const held = typeof args.held?.siteKey === 'string' ? args.held.siteKey : null;
  const given = typeof args.config.siteKey === 'string' ? args.config.siteKey : undefined;
  if (held) {
    if (given !== undefined && given !== held) {
      return refused(
        'WIDGET_SITE_KEY_MINTED',
        `this binding's site key is ${held}; a site key never changes once bound, so send that key back or leave siteKey out.`,
      );
    }
    return { ok: true, config: { ...args.config, siteKey: held } };
  }
  const siteKey = given ?? mintSiteKey();
  // the document's schema already holds the pattern; the check stands where a caller skips it
  if (!WIDGET_SITE_KEY_PATTERN.test(siteKey)) {
    return refused(
      'WIDGET_SITE_KEY_MINTED',
      `a site key is ${WIDGET_SITE_KEY_PREFIX} and 32 base64url characters; mint one, or leave siteKey out and one is minted`,
    );
  }
  const holder = await findBindingIdByConfigValue('widget', 'siteKey', siteKey);
  if (holder !== null && holder !== args.bindingId) {
    return refused(
      'WIDGET_SITE_KEY_TAKEN',
      'another widget binding holds this site key; mint a new key for this one.',
    );
  }
  return { ok: true, config: { ...args.config, siteKey } };
}
