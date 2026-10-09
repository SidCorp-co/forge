// Where previews are served: one label under PREVIEW_DOMAIN, another site from Forge's own
// (`lib/env.ts:previewDomainIssue` refuses one that is not at boot). Unset, nothing is served.

import { PREVIEW_HOST_LABEL, previewLabelOf } from '@forge/contracts/preview';
import { env } from '../lib/env.js';

export interface PreviewSite {
  /** The domain's host, without a port. */
  host: string;
  /** `https:`, or `http:` for a development `host:port`. */
  scheme: 'https:' | 'http:';
  /** The port a development domain names, appended to every preview origin. */
  port: string | null;
}

/** The configured preview site, or null when PREVIEW_DOMAIN is unset. */
export function previewSite(): PreviewSite | null {
  const domain = env.PREVIEW_DOMAIN;
  if (domain === undefined) return null;
  const [host, port] = domain.split(':') as [string, string | undefined];
  return port === undefined
    ? { host, scheme: 'https:', port: null }
    : { host, scheme: 'http:', port };
}

/** `https://<label>.<domain>` (no trailing slash): the origin a preview's viewers load. */
export function previewOrigin(site: PreviewSite, label: string): string {
  return `${site.scheme}//${label}.${site.host}${site.port === null ? '' : `:${site.port}`}`;
}

/** The preview label a request's `Host` names, or null where it is not a preview host. */
export function labelOfHost(host: string | undefined, site: PreviewSite | null): string | null {
  if (!host || site === null) return null;
  return previewLabelOf(host, site.host);
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** A new host label: `p-` and 16 base32 characters, 80 random bits. */
export function newPreviewLabel(random: (n: number) => Uint8Array): string {
  const bytes = random(16);
  let label = 'p-';
  for (const b of bytes) label += BASE32[b % 32];
  if (!PREVIEW_HOST_LABEL.test(label)) throw new Error(`preview label ${label} is malformed`);
  return label;
}
