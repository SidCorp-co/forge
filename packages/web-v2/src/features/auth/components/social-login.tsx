'use client';

import { useEffect, useState } from 'react';
import { Divider, Icon, type IconName } from '@/design';
import {
  fetchOAuthProviders,
  startUrl,
  type OAuthProviderPublic,
} from '../oauth-api';

// Map provider ids to kit icons; GitHub is the only one wired today.
const PROVIDER_ICON: Record<string, IconName> = { github: 'github' };

/**
 * Renders an OAuth button per configured provider, then an "or" divider above
 * the email form. Renders NOTHING (no divider) when the list is empty — which
 * is the default unless core has `FEATURE_SOCIAL_AUTH` + the provider env set —
 * so the email form simply sits at the top of the card. Each button is a plain
 * full-page `<a>` to the core `/start` endpoint (a 302 dance, not an XHR).
 */
export function SocialLogin({ redirectTo = '/' }: { redirectTo?: string }) {
  const [providers, setProviders] = useState<OAuthProviderPublic[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchOAuthProviders().then((list) => {
      if (!cancelled) setProviders(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (providers.length === 0) return null;

  return (
    <div className="mb-5 flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        {providers.map((p) => (
          <a
            key={p.id}
            href={startUrl(p.id, redirectTo)}
            className="fg-label inline-flex w-full items-center justify-center gap-2 rounded-md border border-line-strong bg-surface px-4 py-2.5 text-fg transition-colors hover:bg-hover focus-visible:border-[color:var(--link)] focus-visible:shadow-[var(--shadow-focus)] focus-visible:outline-none"
          >
            <Icon name={PROVIDER_ICON[p.id] ?? 'github'} size={18} />
            {p.label}
          </a>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <Divider className="flex-1" />
        <span className="fg-caption font-mono uppercase tracking-[0.08em]">or</span>
        <Divider className="flex-1" />
      </div>
    </div>
  );
}
