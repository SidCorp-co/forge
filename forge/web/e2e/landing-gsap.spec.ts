import { expect, test } from '@playwright/test';

test('landing page loads without GSAP _gsap TypeError (regression: ISS-262)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);

  const gsapErrors = errors.filter((e) => /_gsap/.test(e));
  expect(gsapErrors, `unexpected GSAP errors:\n${gsapErrors.join('\n')}`).toHaveLength(0);
});
