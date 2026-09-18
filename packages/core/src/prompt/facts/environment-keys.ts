// The three `{{project:}}` keys that read `projects.environments`.
//
// They sit apart from `makeProjectResolver` because what they render is the only part of that
// resolver with a shape of its own: two deployment sides that a skill body is handed as prose, and
// a pointer that must never become a value.
//
// cm:guard the KEY NAMES are `test-urls`, `test-creds` and `test-notes` and they do NOT follow the
// fields. `notes` became `limits` in ISS-1069 and `test-notes` did not, because skill bodies in
// other repositories splice these names, an unresolved `{{project:<key>}}` renders as the empty
// string, and no gate in this repo can see a skill body in another one. Renaming a key here deletes
// a sentence from an agent's prompt with nobody told. `production-branch` is the precedent.

import type { NormalizedEnvironments } from '../../projects/environments.js';

/** Both sides of the deployment, each line saying which side it is on. */
// cm:guard LABELLED, because after ISS-1069 a project has two addresses and an agent handed a bare list cannot tell which one it is allowed to write to. A one-box project renders only the live lines: `preview: null` is that project saying it has no other side, which is a different answer from a preview it has not filled in.
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
// cm:guard a POINTER and never the value: this string is spliced VERBATIM into the device-installed SKILL.md, so whatever it says lands on disk on every paired box.
export const TEST_CREDS_POINTER =
  'Fetch test credentials at runtime via `forge_projects.get` → `environments.testCredentials` (never hardcode secrets).';
