import { REPO_URL, type ReleaseInfo } from '@/lib/github-releases';

interface DownloadQuickstartProps {
  release: ReleaseInfo | null;
}

export function DownloadQuickstart({ release }: DownloadQuickstartProps) {
  return (
    <section id="quickstart" className="scroll-mt-20 relative max-w-5xl mx-auto px-6 py-24 border-t border-outline-variant/20">
      <div className="pointer-events-none absolute top-[10%] left-[-10%] w-[400px] h-[400px] rounded-full bg-[radial-gradient(circle,rgba(249,115,22,0.04)_0%,transparent_70%)]" />

      <div className="text-center mb-14">
        <p className="font-mono text-xs tracking-[0.15em] uppercase text-warning mb-3">
          Quickstart
        </p>
        <h2 className="font-serif text-3xl sm:text-4xl md:text-5xl tracking-tight mb-3">
          Up and running in{' '}
          <span className="bg-gradient-to-r from-amber-400 to-amber-600 bg-clip-text text-transparent">
            three steps
          </span>
        </h2>
      </div>

      <ol className="grid gap-6 max-w-3xl mx-auto">
        {release ? (
          <Step
            n={1}
            title="Install"
            body="Pick the right binary for your OS above, run the installer (or chmod +x for AppImage), and launch Forge Beta."
          />
        ) : (
          // Pre-release: there's no binary "above" to pick from, so Step 1
          // must teach the visitor how to build from source. Removes the
          // contradiction between Platforms ("Binaries coming soon") and a
          // Step 1 that pretended a binary existed.
          <Step
            n={1}
            title="Build from source (pre-release)"
            body="No tagged release yet. Clone the repo, install dependencies, and run the desktop app in dev mode."
            code={[
              `git clone ${REPO_URL}.git`,
              'cd forge/packages/dev',
              'pnpm install',
              'pnpm tauri dev',
            ].join('\n')}
          />
        )}
        <Step
          n={2}
          title="Pair with the cloud server"
          body="Sign in once. The desktop app pairs as a runner device — your Claude CLI sessions stream their work back to the project pipeline."
          code={[
            '# Self-host the cloud server with Docker:',
            `git clone ${REPO_URL}.git && cd forge`,
            'cp .env.example .env   # set JWT_SECRET, DEVICE_TOKEN_PEPPER',
            'docker compose up -d',
            '',
            '# Then open http://localhost:3000 to register and pair.',
          ].join('\n')}
        />
        <Step
          n={3}
          title="Open a project, file an issue, ship"
          body="Issues flow through triage → plan → code → review → release. Each stage maps to a /forge-* skill that the desktop runner executes locally."
          code={[
            '# In the desktop app:',
            '#   1. Add a project (point at your local repo)',
            '#   2. Create an issue',
            '#   3. Watch it flow through the pipeline',
            '',
            '# Or drive the API directly:',
            'curl -H "Authorization: Bearer $TOKEN" \\',
            '  -H "X-Forge-Project-Slug: my-project" \\',
            '  -X POST /api/issues -d \'{"title":"add /api/foo"}\'',
          ].join('\n')}
        />
      </ol>

      {release && (
        <p className="mt-12 text-center text-sm text-primary-fixed font-light">
          Stuck? Check the{' '}
          <a
            className="underline underline-offset-4 decoration-warning/50 text-on-surface hover:decoration-warning hover:text-warning transition-colors"
            href={release.htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {release.tag} release notes
          </a>{' '}
          or open an issue on GitHub.
        </p>
      )}
    </section>
  );
}

function Step({
  n,
  title,
  body,
  code,
}: {
  n: number;
  title: string;
  body: string;
  code?: string;
}) {
  return (
    <li className="grid gap-4 sm:grid-cols-[3.5rem_1fr] sm:gap-6">
      <div className="hidden size-14 items-center justify-center rounded-2xl border border-outline-variant/30 bg-white font-serif text-xl text-warning shadow-sm sm:inline-flex">
        {n}
      </div>
      <div>
        <h3 className="mb-2 font-medium text-on-surface text-lg">
          <span className="mr-2 font-mono text-warning sm:hidden">{n}.</span>
          {title}
        </h3>
        <p className="text-primary-fixed font-light leading-relaxed">{body}</p>
        {code ? (
          <pre className="mt-4 overflow-x-auto rounded-xl border border-outline-variant/20 bg-surface-container-low/40 p-4 font-mono text-xs leading-relaxed text-on-surface">
            {code}
          </pre>
        ) : null}
      </div>
    </li>
  );
}
