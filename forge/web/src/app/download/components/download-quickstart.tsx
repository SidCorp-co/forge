import { REPO_URL, type ReleaseInfo } from '@/lib/github-releases';

interface DownloadQuickstartProps {
  release: ReleaseInfo | null;
}

export function DownloadQuickstart({ release }: DownloadQuickstartProps) {
  return (
    <section id="quickstart" className="border-b border-outline-variant/30">
      <div className="mx-auto max-w-5xl px-6 py-20">
        <div className="mb-10">
          <p className="mb-2 font-mono text-xs uppercase tracking-[0.15em] text-on-surface-variant">
            Quickstart
          </p>
          <h2 className="font-serif text-3xl tracking-tight sm:text-4xl">
            Up and running in three steps
          </h2>
        </div>

        <ol className="grid gap-6">
          <Step
            n={1}
            title="Install"
            body="Pick the right binary for your OS above, run the installer (or chmod +x for AppImage), and launch Forge Beta."
          />

          <Step
            n={2}
            title="Pair with the cloud server"
            body="Sign in once with your account. The desktop app pairs as a runner device — your Claude CLI sessions stream their work back to the project pipeline."
            code={[
              '# (Optional) self-host the cloud server with Docker',
              `git clone ${REPO_URL}.git && cd jarvis-agents`,
              `# Or skip self-hosting and use the hosted instance:`,
              `# https://stg-jarvis-a2.thejunix.com`,
            ].join('\n')}
          />

          <Step
            n={3}
            title="Open a project, file an issue, ship"
            body="Issues flow through triage → plan → code → review → release. Each stage maps to a /forge-* skill that the desktop runner executes locally. You stay in control."
            code={[
              '# In the desktop app:',
              '# 1. Add a project (point at your local repo)',
              '# 2. Create an issue',
              '# 3. Watch it flow through the pipeline',
              '',
              '# Or drive the API directly:',
              'curl -H "Authorization: Bearer $TOKEN" \\',
              '  -H "X-Forge-Project-Slug: my-project" \\',
              '  -X POST /api/issues -d \'{"title":"add /api/foo"}\'',
            ].join('\n')}
          />
        </ol>

        {release && (
          <p className="mt-10 text-sm text-on-surface-variant">
            Stuck? Check the{' '}
            <a
              className="text-[#82c4f8] underline hover:text-[#a8d4ff]"
              href={release.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {release.tag} release notes
            </a>{' '}
            or open an issue on GitHub.
          </p>
        )}
      </div>
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
    <li className="grid gap-4 sm:grid-cols-[3rem_1fr] sm:gap-6">
      <div className="hidden size-12 items-center justify-center rounded-md border border-outline-variant/40 bg-surface-container-low/60 font-mono text-lg text-on-surface-variant sm:inline-flex">
        {n}
      </div>
      <div>
        <h3 className="mb-2 font-semibold text-on-surface">
          <span className="mr-2 font-mono text-on-surface-variant sm:hidden">{n}.</span>
          {title}
        </h3>
        <p className="text-on-surface-variant">{body}</p>
        {code ? (
          <pre className="mt-3 overflow-x-auto rounded-md border border-outline-variant/30 bg-[#0a0a0a] p-4 font-mono text-xs leading-relaxed text-on-surface">
            {code}
          </pre>
        ) : null}
      </div>
    </li>
  );
}
