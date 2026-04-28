import Link from 'next/link';
import { fetchLatestRelease } from '@/lib/github-releases';

const PITCH = 'From idea to working POC.\nIn days, not months.';

const BADGES = [
  'Open Source · Apache-2.0',
  'Local-first runner',
  'MCP-native',
] as const;

/**
 * Server component — calls fetchLatestRelease() so the version line tracks
 * the actual shipping desktop release without anyone hardcoding it. When no
 * release exists yet (pre-tag, API down) the version line collapses to just
 * "Beta" so we never lie to the visitor.
 */
export async function BrandPanel() {
  const release = await fetchLatestRelease();
  const versionLine = release ? `v${release.version} · Beta` : 'Beta';

  return (
    <aside className="relative hidden lg:flex flex-col justify-between min-h-full pl-10 py-12">
      <span aria-hidden className="absolute left-0 top-12 bottom-12 w-[2px] bg-warning/70" />

      <Link
        href="/"
        className="inline-flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.32em] text-on-surface hover:text-warning transition-colors"
      >
        <span aria-hidden className="block h-2 w-2 bg-warning" />
        Forge
      </Link>

      <div className="max-w-[380px]">
        <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-on-surface-variant">
          POC Studio · junixlabs
        </p>
        <h2 className="mt-5 whitespace-pre-line text-[32px] leading-[1.08] tracking-tight text-on-surface">
          {PITCH}
        </h2>
        <p className="mt-5 text-[14px] leading-relaxed text-on-surface-variant max-w-[340px]">
          A local-first build console for shipping proof-of-concept work fast.
          Sign in to drive issues through the pipeline, or create an account to
          start a new project.
        </p>

        <ul className="mt-8 space-y-2.5">
          {BADGES.map((b) => (
            <li
              key={b}
              className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.22em] text-on-surface-variant"
            >
              <span aria-hidden className="block h-px w-5 bg-outline-variant" />
              {b}
            </li>
          ))}
          <li className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.22em] text-warning">
            <span aria-hidden className="block h-px w-5 bg-warning/60" />
            {versionLine}
          </li>
        </ul>
      </div>

      <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.22em] text-on-surface-variant/70">
        <Link href="/download" className="hover:text-on-surface transition-colors">
          ← Download desktop
        </Link>
        <Link
          href="https://github.com/SidCorp-co/forge"
          className="hover:text-on-surface transition-colors"
          target="_blank"
          rel="noreferrer"
        >
          Source ↗
        </Link>
      </div>
    </aside>
  );
}
