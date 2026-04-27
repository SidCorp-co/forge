import { expect, test } from '@playwright/test';

/**
 * Phase G smoke (ISS-300 → ISS-305): chat from web should land an
 * assistant message in the panel after the desktop runner finishes.
 *
 * Backend pipeline is independently verified — the BE half published
 * agent-session.relay.agent:batch + agent:complete events to the
 * project room and the web's WebSocket DOES receive them
 * (verified via a `WebSocket` monkey-patch hook). What's still
 * broken is the UI render: the assistant text never appears in the
 * chat panel, even though the bundle ships the unwrap + batch
 * handler in `use-agent-ws-handlers.ts`.
 *
 * This spec is intentionally written against staging so it exercises
 * the real Cloudflare-Tunnel + DNS-only-WS-subdomain plumbing rather
 * than a localhost mock; flip E2E_WEB_URL / E2E_BASE_URL to swap.
 */

const STG_URL = process.env.E2E_WEB_URL ?? 'https://stg-jarvis-a2.thejunix.com';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@thejunix.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'admin12345';
const PROJECT_SLUG = process.env.E2E_PROJECT_SLUG ?? 'apiflow';

interface CapturedSocket {
  url: string;
  opened: boolean;
  closed: boolean;
  sent: unknown[];
  msgs: { event?: string; sessionId?: string }[];
}

declare global {
  interface Window {
    __forgeWSCaptured?: CapturedSocket[];
  }
}

test.describe('Phase G — agent chat assistant reply', () => {
  test.setTimeout(120_000);

  test('send "reply with the digit 3" → assistant text "3" renders in chat panel', async ({
    page,
    context,
  }) => {
    // === LOGIN ===
    // Cookie-based auth via /api/auth/local. The forge_auth cookie is
    // Domain=.thejunix.com (set by AUTH_COOKIE_DOMAIN on stg) so it
    // travels to the WS subdomain too.
    await test.step('login via /api/auth/local', async () => {
      const res = await context.request.post(`${STG_URL}/api/auth/local`, {
        data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.status(), 'login should succeed').toBe(200);
      const cookies = await context.cookies();
      const auth = cookies.find((c) => c.name === 'forge_auth');
      expect(auth, 'forge_auth cookie must be set').toBeDefined();
    });

    // === INSTALL WS HOOK BEFORE NAVIGATION ===
    // Install on a static HTML route first so the hook is in place
    // when the SPA boots and creates its WebSocket(s).
    await test.step('install WS capture hook on a quiet route', async () => {
      await page.goto(`${STG_URL}/login`, { waitUntil: 'domcontentloaded' });
      await page.addInitScript(() => {
        const orig = window.WebSocket;
        const captured: CapturedSocket[] = [];
        window.__forgeWSCaptured = captured;
        // @ts-expect-error monkey-patch
        window.WebSocket = class extends orig {
          constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            const entry: CapturedSocket = {
              url: String(url),
              opened: false,
              closed: false,
              sent: [],
              msgs: [],
            };
            captured.push(entry);
            const send = this.send.bind(this);
            this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
              try {
                entry.sent.push(JSON.parse(String(data)));
              } catch {
                /* ignore */
              }
              send(data as string);
            };
            this.addEventListener('open', () => {
              entry.opened = true;
            });
            this.addEventListener('message', (ev: MessageEvent) => {
              try {
                const m = JSON.parse(String(ev.data));
                entry.msgs.push({ event: m.event, sessionId: m.data?.sessionId });
              } catch {
                /* ignore */
              }
              if (entry.msgs.length > 200) entry.msgs.shift();
            });
            this.addEventListener('close', () => {
              entry.closed = true;
            });
          }
        };
      });
    });

    // === NAVIGATE TO AGENT PAGE ===
    await test.step('open agent page', async () => {
      await page.goto(`${STG_URL}/projects/${PROJECT_SLUG}/agent`, {
        waitUntil: 'domcontentloaded',
      });
      // The agent page must show "Desktop connected" before we can chat.
      await expect(page.getByText(/desktop connected/i)).toBeVisible({ timeout: 15_000 });
    });

    // === SEND THE MESSAGE ===
    const probe = `Phase G E2E ${Date.now()} - reply with the digit 3`;
    await test.step('type + send chat message', async () => {
      const input = page.getByPlaceholder('Message...');
      await input.fill(probe);
      // The send button is the round svg-only button next to the textarea.
      // It enables once the input is non-empty; click as soon as enabled.
      const sendBtn = page
        .locator('button:has(svg)')
        .filter({ hasNot: page.locator('text=/.+/') })
        .last();
      await expect(sendBtn).toBeEnabled({ timeout: 5_000 });
      await sendBtn.click();
      // The URL gains ?session=<uuid> right after start returns 201.
      await expect(page).toHaveURL(/[?&]session=[0-9a-f-]{36}/, { timeout: 10_000 });
    });

    // === ASSERT ASSISTANT REPLY RENDERS ===
    // The bug under test: events arrive on the WS but the assistant
    // text never lands in the chat panel. Wait up to 30s for a chat
    // message containing "3" that is NOT the user's prompt.
    let assistantRendered = false;
    try {
      await expect(async () => {
        const chat = page.locator('[class*="chat-prose"]').first();
        const text = await chat.innerText();
        // The probe contains "digit 3" — ignore that occurrence by
        // checking the chat history has a message that's just "3"
        // (or starts with "3") AFTER the user's prompt line.
        const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
        const userIdx = lines.findIndex((l) => l.includes(probe));
        const after = lines.slice(userIdx + 1).join(' ');
        expect(after, `assistant reply not rendered. Chat after user prompt:\n${after}`).toMatch(
          /\b3\b/,
        );
      }).toPass({ timeout: 30_000, intervals: [500, 1_000, 2_000] });
      assistantRendered = true;
    } catch (err) {
      // Capture diagnostic state before re-throwing so the bug report
      // has the WS event sequence + DOM snapshot to work from.
      const wsState = await page.evaluate(() => {
        const cap = window.__forgeWSCaptured ?? [];
        return cap.map((c) => ({
          url: c.url,
          opened: c.opened,
          closed: c.closed,
          sent: c.sent,
          msgEvents: c.msgs.map((m) => `${m.event ?? '?'}${m.sessionId ? '/' + m.sessionId.slice(0, 8) : ''}`),
        }));
      });
      const chatText = await page.locator('[class*="chat-prose"]').first().innerText().catch(() => '(unavailable)');
      const consoleErrors = (page as unknown as { _consoleErrors?: string[] })._consoleErrors ?? [];

      // Persist diagnostic for the bug report.
      await page
        .context()
        .request.fetch('about:blank')
        .catch(() => {});
      // eslint-disable-next-line no-console
      console.log('=== Phase G E2E DIAGNOSTIC ===');
      // eslint-disable-next-line no-console
      console.log('probe:', probe);
      // eslint-disable-next-line no-console
      console.log('chatText:\n', chatText);
      // eslint-disable-next-line no-console
      console.log('wsState:', JSON.stringify(wsState, null, 2));
      // eslint-disable-next-line no-console
      console.log('consoleErrors:', consoleErrors.slice(-10));
      throw err;
    }

    expect(assistantRendered).toBe(true);
  });
});
