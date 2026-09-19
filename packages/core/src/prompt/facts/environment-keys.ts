import type { NormalizedEnvironments } from '../../projects/environments.js';

/** Both sides of the deployment, each line saying which side it is on. */
export function renderTestUrls(env: NormalizedEnvironments): string | undefined {
  const lines: string[] = [];
  if (env.preview) {
    if (env.preview.url) lines.push(`- Preview: ${env.preview.url}`);
    if (env.preview.apiUrl) lines.push(`- Preview API: ${env.preview.apiUrl}`);
    for (const u of env.preview.urls) {
      lines.push(`- Preview${u.label ? ` (${u.label})` : ''}: ${u.url}`);
    }
  }
  if (env.live.url) lines.push(`- Live: ${env.live.url}`);
  if (env.live.apiUrl) lines.push(`- Live API: ${env.live.apiUrl}`);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/** Where to fetch the credentials, and never a credential. */
export const TEST_CREDS_POINTER =
  'Fetch test credentials at runtime via `forge_projects.get` → `environments.testCredentials` (never hardcode secrets).';
