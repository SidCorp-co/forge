import { expect, test } from '@playwright/test';

/**
 * ISS-311 regression spec: chat module text in light mode must clear
 * WCAG AA contrast (4.5:1 for normal body text, 3:1 for ≥18px / bold ≥14px).
 *
 * Pre-311 the ISS-308 token sweep mapped many `text-[#555/666/444]` muted
 * strings to `text-outline`. The Material You light theme defines
 * `--color-outline: #867461` (warm brown) which only clears 4.0–4.5:1
 * against the light surface family — borderline AA, fail at small sizes.
 * The fix re-mapped chat-module muted text to `text-on-surface-variant`
 * (#534434, ~8.4:1). Spec walks each visible muted text in a session and
 * asserts the rendered text/background pair clears 4.5:1.
 */

const STG_URL = process.env.E2E_WEB_URL ?? 'https://stg-jarvis-a2.thejunix.com';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@thejunix.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'admin12345';
const PROJECT_SLUG = process.env.E2E_PROJECT_SLUG ?? 'apiflow';

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function relLuminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function parseRgb(str: string): [number, number, number] | null {
  const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function contrastRatio(fg: string, bg: string): number | null {
  const f = parseRgb(fg);
  const b = parseRgb(bg);
  if (!f || !b) return null;
  const lf = relLuminance(f);
  const lb = relLuminance(b);
  const [hi, lo] = lf > lb ? [lf, lb] : [lb, lf];
  return (hi + 0.05) / (lo + 0.05);
}

test.describe('ISS-311 — light-mode chat text contrast', () => {
  test.setTimeout(60_000);

  test('every visible muted text in the session list clears WCAG AA (4.5:1) on light theme', async ({
    page,
    context,
  }) => {
    const login = await context.request.post(`${STG_URL}/api/auth/local`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(login.status()).toBe(200);

    await page.goto(`${STG_URL}/projects/${PROJECT_SLUG}/agent`, {
      waitUntil: 'domcontentloaded',
    });

    // Force light mode via the user-prefs API (idempotent — server is the
    // source of truth, and the hydrate-once useEffect will pick it up).
    await context.request.patch(`${STG_URL}/api/auth/preferences`, {
      data: { theme: 'light' },
      headers: { 'Content-Type': 'application/json' },
    });
    // Reload so the new pref propagates through the hydrate path cleanly.
    await page.reload({ waitUntil: 'domcontentloaded' });

    await expect.poll(
      async () => page.evaluate(() => document.documentElement.getAttribute('data-theme')),
      { timeout: 10_000 },
    ).toBe('light');

    // Open the first available session so the chat-prose container exists
    // and has rendered messages. If there are no sessions, fall back to the
    // empty-state panel.
    await page.waitForTimeout(1_500);
    const firstSession = page.locator('[class*="divide-y"] > *').first();
    if (await firstSession.count()) {
      await firstSession.click().catch(() => {});
      await page.waitForTimeout(1_000);
    }
    await expect(page.locator('main')).toBeVisible({ timeout: 10_000 });

    // Probe every text node within the chat sidebar/main panel and collect
    // the rendered (computed) text + background colors. Skip nodes with
    // empty text or text equal to whitespace/punctuation (icons,
    // separators) — they don't carry user-facing content.
    const rendered = await page.evaluate(() => {
      // ISS-311 scope: chat module only. The shell/sidebar uses
      // `text-primary-fixed` and `text-outline-variant` in places that also
      // fail AA in light mode — tracked separately as ISS-312 (light-mode
      // shell sweep). Restrict to the chat container so this spec doesn't
      // bleed into out-of-scope regressions.
      // Strict scope: chat-prose container only. If absent (no session
      // selected) fall back to <main> but exclude <aside>/<nav> children.
      const chatProse = document.querySelector('[class*="chat-prose"]');
      const root: Element = chatProse ?? document.querySelector('main') ?? document.body;
      const out: { text: string; fg: string; bg: string; fontSize: number; selector: string }[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const text = node.textContent?.trim();
        if (!text || text.length < 2) continue;
        if (/^[\s\-·•▶▼⏵⎿+\-]+$/.test(text)) continue;
        const el = node.parentElement;
        if (!el) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        // Walk up to find a non-transparent background.
        let bg = cs.backgroundColor;
        let cursor: HTMLElement | null = el;
        while (cursor && (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent')) {
          cursor = cursor.parentElement;
          bg = cursor ? getComputedStyle(cursor).backgroundColor : 'rgb(255, 255, 255)';
        }
        out.push({
          text: text.slice(0, 60),
          fg: cs.color,
          bg: bg || 'rgb(255, 255, 255)',
          fontSize: parseFloat(cs.fontSize),
          selector: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ').slice(0, 2).join('.') : ''),
        });
      }
      return out;
    });

    // Compute contrast for each, filter to chat-context text only (skip
    // sidebar nav links and project picker — those are out of ISS-311
    // scope). Heuristic: anything inside elements whose computed bg is in
    // the surface family (grayscale ~240+ in light mode).
    const failures: { text: string; ratio: number; fg: string; bg: string; selector: string }[] = [];
    for (const node of rendered) {
      const ratio = contrastRatio(node.fg, node.bg);
      if (ratio == null) continue;
      // WCAG AA: 4.5:1 for normal text, 3:1 for ≥18px or ≥14px+bold.
      const isLarge = node.fontSize >= 18;
      const threshold = isLarge ? 3 : 4.5;
      if (ratio < threshold) {
        failures.push({
          text: node.text,
          ratio: Number(ratio.toFixed(2)),
          fg: node.fg,
          bg: node.bg,
          selector: node.selector,
        });
      }
    }

    expect(
      failures,
      `Light-mode contrast violations (need ≥4.5:1 for body text):\n${failures
        .map((f) => `  "${f.text}" — ${f.ratio}:1 (${f.fg} on ${f.bg}) [${f.selector}]`)
        .join('\n')}`,
    ).toEqual([]);
  });
});
