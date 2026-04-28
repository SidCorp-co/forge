import { fetchOAuthProviders, startUrl } from '@/lib/api/oauth-api';
import { ProviderIcon } from './provider-icon';

/**
 * Server component — fetches the live provider list at SSR time. Renders
 * nothing when no providers are configured (FEATURE_SOCIAL_AUTH off,
 * env vars unset, or backend unreachable), so the email form simply
 * appears at the top of the card without an empty divider.
 */
export async function SocialLogin({ redirectTo = '/projects' }: { redirectTo?: string }) {
  const providers = await fetchOAuthProviders();
  if (providers.length === 0) return null;

  return (
    <div className="space-y-4 mb-8">
      <div className="grid gap-3">
        {providers.map((p) => (
          <a
            key={p.id}
            href={startUrl(p.id, redirectTo)}
            className="group flex items-center justify-center gap-3 border border-outline-variant/60 bg-surface-container-lowest py-3 font-mono text-[11px] uppercase tracking-[0.18em] text-on-surface transition-colors hover:border-warning hover:text-warning focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning focus-visible:ring-offset-2 focus-visible:ring-offset-surface-container-lowest"
          >
            <ProviderIcon id={p.id} />
            <span>{p.label}</span>
          </a>
        ))}
      </div>
      <div className="flex items-center gap-3" role="separator">
        <span aria-hidden className="h-px flex-1 bg-outline-variant" />
        <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-on-surface-variant">
          or with email
        </span>
        <span aria-hidden className="h-px flex-1 bg-outline-variant" />
      </div>
    </div>
  );
}
