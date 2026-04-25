import { expect, test } from '@playwright/test';

test.describe('custom 404 page (regression: ISS-261)', () => {
  test('unknown path renders 404 component without redirecting to /login', async ({ page }) => {
    const response = await page.goto('/__definitely-not-a-route');

    expect(response?.status()).toBe(404);
    expect(page.url()).toContain('/__definitely-not-a-route');
    expect(page.url()).not.toContain('/login');

    await expect(page.getByText('Error 404')).toBeVisible();
    await expect(page.getByRole('heading', { name: /page not found/i })).toBeVisible();

    const backLink = page.getByRole('link', { name: /back to projects/i });
    await expect(backLink).toBeVisible();
    await expect(backLink).toHaveAttribute('href', '/projects');
  });

  test('protected route still redirects 307 to /login when unauthenticated', async ({ request, page }) => {
    const raw = await request.get('/projects', { maxRedirects: 0 });
    expect(raw.status()).toBe(307);
    expect(raw.headers()['location']).toMatch(/\/login$/);

    await page.goto('/projects');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('404 page is visually distinguishable from /login', async ({ page }) => {
    await page.goto('/__definitely-not-a-route');
    await expect(page.getByLabel(/email/i)).toHaveCount(0);
    await expect(page.getByLabel(/password/i)).toHaveCount(0);

    await page.goto('/login');
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
  });
});
