import { expect, test } from '@playwright/test';

/**
 * ISS-309 regression spec: the sidebar Dark Mode/Light Mode toggle must
 * produce a *visible* theme flip with no revert flicker.
 *
 * Pre-309 bug 1 (revert race): each click produced 3 data-theme attribute
 *   mutations within ~280ms (light → dark → light) because the
 *   useThemePreference effect listed `theme` in its deps and reverted to
 *   the stale server value before the PATCH onSuccess landed. Spec asserts
 *   exactly 1 attribute change per click.
 *
 * Pre-309 bug 2 (React #418 hydration mismatch): the toggle and the
 *   settings AppearanceCard branched on resolvedTheme during the first
 *   paint, producing different SSR vs client DOM and causing a subtree
 *   unmount/remount on boot. Spec asserts no `Minified React error #418`
 *   in console on a cold load.
 */

const STG_URL = process.env.E2E_WEB_URL ?? 'https://stg-jarvis-a2.thejunix.com';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@thejunix.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'admin12345';
const PROJECT_SLUG = process.env.E2E_PROJECT_SLUG ?? 'apiflow';

interface ThemeProbe {
  dataTheme: string | null;
  bodyBg: string;
  surface: string;
  onSurface: string;
}

declare global {
  interface Window {
    __themeAttrLog?: string[];
  }
}

test.describe('ISS-309 — theme toggle', () => {
  test.setTimeout(60_000);

  test('toggle flips dark ↔ light with one attribute change per click and visible CSS-var diff', async ({
    page,
    context,
  }) => {
    // Login first so the theme-prefs PATCH succeeds and the optimistic
    // queryData write actually has a server round-trip to confirm.
    const login = await context.request.post(`${STG_URL}/api/auth/local`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(login.status(), 'login should succeed').toBe(200);

    // Cold-load + capture console errors to assert no React #418.
    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => consoleErrors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto(`${STG_URL}/projects/${PROJECT_SLUG}/agent`, {
      waitUntil: 'domcontentloaded',
    });

    // Wait for the toggle to be visible (means the shell + theme provider mounted).
    const toggle = page.locator('button', { hasText: /Dark Mode|Light Mode/ });
    await expect(toggle).toBeVisible({ timeout: 15_000 });

    // Install MutationObserver on <html data-theme=""> *after* mount so the
    // pre-mount next-themes inline script attribute set isn't counted.
    await page.evaluate(() => {
      const log: string[] = [];
      const obs = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type === 'attributes' && m.attributeName === 'data-theme') {
            log.push(`${Date.now()} ${document.documentElement.getAttribute('data-theme')}`);
          }
        }
      });
      obs.observe(document.documentElement, { attributes: true });
      window.__themeAttrLog = log;
    });

    const probe = async (): Promise<ThemeProbe> =>
      page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        return {
          dataTheme: document.documentElement.getAttribute('data-theme'),
          bodyBg: getComputedStyle(document.body).backgroundColor,
          surface: cs.getPropertyValue('--color-surface').trim(),
          onSurface: cs.getPropertyValue('--color-on-surface').trim(),
        };
      });

    // Capture initial theme and snapshot CSS vars.
    const before = await probe();

    // Click the toggle, wait for the attribute to flip.
    await toggle.click();
    await expect
      .poll(async () => (await probe()).dataTheme, { timeout: 5_000 })
      .not.toBe(before.dataTheme);

    const afterFirst = await probe();

    // Theme actually flipped: the data-theme attribute differs and the
    // resolved CSS variables genuinely changed (proves Material You tokens
    // are being re-resolved, not just the attribute).
    expect(afterFirst.dataTheme, 'data-theme should flip').not.toBe(before.dataTheme);
    expect(afterFirst.surface, '--color-surface should change with theme').not.toBe(before.surface);
    expect(afterFirst.onSurface, '--color-on-surface should change with theme').not.toBe(
      before.onSurface,
    );
    expect(afterFirst.bodyBg, 'body background should change with theme').not.toBe(before.bodyBg);

    // Wait for any in-flight PATCH onSuccess to land (would revert pre-309).
    await page.waitForTimeout(1_500);

    // No revert: the attribute log should show exactly one change since the
    // observer was installed (the click we just did). Pre-309 this would
    // be 3 within the first ~280ms window.
    const logAfterFirst = await page.evaluate(() => window.__themeAttrLog ?? []);
    expect(
      logAfterFirst.length,
      `exactly one data-theme mutation per click; saw ${JSON.stringify(logAfterFirst)}`,
    ).toBe(1);

    // Toggle back — verify it returns to the original theme cleanly.
    await toggle.click();
    await expect
      .poll(async () => (await probe()).dataTheme, { timeout: 5_000 })
      .toBe(before.dataTheme);

    await page.waitForTimeout(1_500);

    const finalProbe = await probe();
    expect(finalProbe.surface, 'surface should match original after round-trip').toBe(
      before.surface,
    );

    const logAfterRoundTrip = await page.evaluate(() => window.__themeAttrLog ?? []);
    expect(
      logAfterRoundTrip.length,
      `two clicks → exactly two attribute changes; saw ${JSON.stringify(logAfterRoundTrip)}`,
    ).toBe(2);

    // Cold-load hydration must not produce React error #418. Filter only
    // the 418 signature so unrelated console noise (e.g. notification
    // endpoint redirects) doesn't fail the spec.
    const reactHydrationErrors = consoleErrors.filter((e) =>
      /Minified React error #418|Hydration failed/i.test(e),
    );
    expect(
      reactHydrationErrors,
      `no React #418 hydration mismatch; saw:\n${reactHydrationErrors.join('\n')}`,
    ).toEqual([]);
  });
});
