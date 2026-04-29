import { cookies } from 'next/headers';
import Link from 'next/link';

// Always SSR — we read the auth cookie and POST to core, neither cacheable.
export const dynamic = 'force-dynamic';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api';
// Custom URL scheme registered by the Tauri client (ADR 0017). Kept in
// sync with `tauri.conf.json` plugins.deep-link.desktop.schemes.
const DESKTOP_SCHEME = 'forge-beta';

interface HandoffPageProps {
  searchParams: Promise<{ handoff?: string }>;
}

interface IssueCodeOk {
  code: string;
}

interface IssueCodeError {
  status: number;
  code: string;
  message: string;
}

type IssueCodeResult = { ok: true; data: IssueCodeOk } | { ok: false; error: IssueCodeError };

/**
 * Server-side mint of a one-time desktop handoff code. Forwards the auth
 * cookie as a Bearer token so the API recognises the user — same shape as
 * the rest of the auth surface.
 */
async function issueCode(handoffId: string): Promise<IssueCodeResult> {
  const jar = await cookies();
  const jwt = jar.get('forge_auth')?.value;
  if (!jwt) {
    return {
      ok: false,
      error: {
        status: 401,
        code: 'UNAUTHENTICATED',
        message: 'You need to be signed in to complete the desktop handoff.',
      },
    };
  }

  let res: Response;
  try {
    res = await fetch(`${API_URL}/auth/desktop/issue-code`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ handoff_id: handoffId }),
      cache: 'no-store',
    });
  } catch {
    return {
      ok: false,
      error: {
        status: 502,
        code: 'API_UNREACHABLE',
        message: 'Could not reach the Forge API. Check your connection and try again.',
      },
    };
  }

  if (!res.ok) {
    let body: { code?: string; message?: string } = {};
    try {
      body = (await res.json()) as { code?: string; message?: string };
    } catch {
      // non-JSON body — leave fields undefined
    }
    return {
      ok: false,
      error: {
        status: res.status,
        code: body.code ?? 'HANDOFF_FAILED',
        message: body.message ?? 'Could not complete the desktop handoff.',
      },
    };
  }

  const data = (await res.json()) as IssueCodeOk;
  return { ok: true, data };
}

export default async function DesktopHandoffPage({ searchParams }: HandoffPageProps) {
  const sp = await searchParams;
  const handoffId = typeof sp.handoff === 'string' ? sp.handoff : '';

  if (!handoffId) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <ErrorCard
          title="Missing handoff token"
          message="Open the Forge desktop app and start the sign-in again — this URL is only valid as part of the desktop OAuth flow."
        />
      </main>
    );
  }

  const result = await issueCode(handoffId);
  if (!result.ok) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <ErrorCard title="Could not complete sign-in" message={result.error.message} />
      </main>
    );
  }

  const deepLink = `${DESKTOP_SCHEME}://auth/callback?handoff_id=${encodeURIComponent(handoffId)}&code=${encodeURIComponent(result.data.code)}`;

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md border-l-2 border-l-success bg-surface px-8 py-10">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-success">
          Authenticated ✓
        </p>
        <h1 className="mt-2 font-mono text-xl font-semibold text-on-surface">
          Returning to Forge Desktop…
        </h1>
        <p className="mt-4 text-sm text-on-surface-variant">
          The desktop app should open automatically. If it doesn&apos;t, click the button below.
        </p>

        {/*
          Auto-redirect via meta refresh + JS fallback. Browsers handle custom
          schemes inconsistently — Firefox shows a permission prompt, Chrome
          opens silently, Safari opens silently. The manual button is the
          guaranteed-working fallback for any case the auto path fails.
        */}
        <meta httpEquiv="refresh" content={`0; url=${deepLink}`} />
        <script
          dangerouslySetInnerHTML={{
            __html: `setTimeout(function(){window.location.href=${JSON.stringify(deepLink)};}, 100);`,
          }}
        />

        <div className="mt-8 flex flex-col gap-3">
          <a
            href={deepLink}
            className="block w-full border-l-2 border-l-warning bg-warning/10 px-4 py-3 text-center font-mono text-[12px] uppercase tracking-[0.16em] text-on-surface hover:bg-warning/20 transition-colors"
          >
            Open Forge Desktop ↗
          </a>
          <p className="text-center font-mono text-[11px] uppercase tracking-[0.16em] text-on-surface-variant">
            You can close this tab when the desktop app opens.
          </p>
        </div>

        <hr className="my-8 border-t border-outline-variant" />
        <p className="text-xs text-on-surface-variant">
          Don&apos;t have the desktop app installed?{' '}
          <Link href="/download" className="underline decoration-warning underline-offset-4">
            Get it here
          </Link>
          .
        </p>
      </div>
    </main>
  );
}

function ErrorCard({ title, message }: { title: string; message: string }) {
  return (
    <div className="w-full max-w-md border-l-2 border-l-warning bg-surface px-8 py-10">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-warning">Error</p>
      <h1 className="mt-2 font-mono text-xl font-semibold text-on-surface">{title}</h1>
      <p className="mt-4 text-sm text-on-surface-variant">{message}</p>
      <Link
        href="/login"
        className="mt-8 inline-block border-l-2 border-l-warning bg-warning/10 px-4 py-3 font-mono text-[12px] uppercase tracking-[0.16em] text-on-surface hover:bg-warning/20 transition-colors"
      >
        ← Back to sign in
      </Link>
    </div>
  );
}
