// The pages a preview host answers in Forge's own words, never the dev server's: the link closed,
// starting, refused, or unknown. Plain HTML with no script, so a preview host serves nothing of
// Forge's that could act.

import type { ServerResponse } from 'node:http';
import type { PreviewFailureReason, PreviewState } from '@forge/contracts/preview';

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface Page {
  status: number;
  title: string;
  body: string;
  /** Seconds after which the browser asks again; the starting page waits for the dev server. */
  refresh?: number;
}

export function sendPage(res: ServerResponse, page: Page): void {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(page.title)}</title><style>body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:48px 24px;color:#1f2328;background:#fff}main{max-width:560px;margin:0 auto}h1{font-size:20px;margin:0 0 8px}p{margin:0 0 8px;color:#57606a}@media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}p{color:#9198a1}}</style></head><body><main><h1>${escapeHtml(page.title)}</h1>${page.body
    .split('\n')
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('')}</main></body></html>`;
  res.writeHead(page.status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex, nofollow',
    ...(page.refresh === undefined ? {} : { refresh: String(page.refresh) }),
  });
  res.end(html);
}

const CLOSED_TITLE: Partial<Record<PreviewState, string>> = {
  approved: 'This preview was approved',
  abandoned: 'This preview was abandoned',
  failed: 'This preview could not run',
  idle_closed: 'This preview closed while nobody viewed it',
};

/** The page a closed link answers (BC-9): which way it closed, and what a person can do next. */
export function closedPage(row: {
  state: PreviewState;
  reason: PreviewFailureReason | null;
  detail: string | null;
  idleMinutes: number;
}): Page {
  const lines: string[] = [];
  if (row.state === 'approved') {
    lines.push('Its change was approved and goes on to be merged; open the issue to follow it.');
  } else if (row.state === 'abandoned') {
    lines.push(`It was closed without approval${row.detail ? `: ${row.detail}` : '.'}`);
  } else if (row.state === 'failed') {
    lines.push(`${row.reason ?? 'It failed'}${row.detail ? `: ${row.detail}` : ''}`);
  } else if (row.state === 'idle_closed') {
    lines.push(
      `Nobody viewed it for ${row.idleMinutes} minutes, so its dev server was stopped. A project member who can write reopens it by opening it again from the issue.`,
    );
  }
  return {
    status: 410,
    title: CLOSED_TITLE[row.state] ?? 'This preview is closed',
    body: lines.join('\n'),
  };
}

export const startingPage = (): Page => ({
  status: 503,
  title: 'This preview is starting',
  body: "The dev server is starting in the run's worktree. This page reloads on its own.",
  refresh: 2,
});

export const notFoundPage = (): Page => ({
  status: 404,
  title: 'No preview at this link',
  body: 'This address names no preview. Open the preview from its issue in Forge.',
});

export const enterRefusedPage = (): Page => ({
  status: 403,
  title: 'This link has already been used or has expired',
  body: 'A preview link from Forge lets one browser in once, within a minute. Open the preview again from its issue.',
});

export const signInPage = (): Page => ({
  status: 403,
  title: 'Open this preview from Forge',
  body: 'Only signed-in members of the project can view its preview. Open it from the issue in Forge.',
});

export const notMemberPage = (): Page => ({
  status: 403,
  title: 'You are not a member of this project',
  body: 'Only signed-in members of the project can view its preview.',
});

export const tunnelDownPage = (why: 'TUNNEL_DOWN' | 'STREAM_LIMIT'): Page =>
  why === 'TUNNEL_DOWN'
    ? {
        status: 503,
        title: 'The box serving this preview is not connected',
        body: 'Its connection to Forge dropped. This page reloads on its own; the preview fails if the box stays away.',
        refresh: 5,
      }
    : {
        status: 503,
        title: 'This preview is busy',
        body: 'It holds as many connections as one preview may. Close other tabs of it and reload.',
      };

export const devServerErrorPage = (code: string): Page => ({
  status: 502,
  title: 'The dev server did not answer',
  body: `The box could not reach the dev server (${code}). It may be restarting; reload in a moment.`,
  refresh: 3,
});
