import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

const envState: { NODE_ENV: 'development' | 'test' | 'staging' | 'production' } = {
  NODE_ENV: 'test',
};

vi.mock('../config/env.js', () => ({
  env: new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (prop === 'NODE_ENV') return envState.NODE_ENV;
      return undefined;
    },
  }),
}));

const { setAuthCookie, clearAuthCookie, AUTH_COOKIE_NAME } = await import('./cookie.js');

function buildApp() {
  const app = new Hono();
  app.get('/set', (c) => {
    setAuthCookie(c, 'token-value');
    return c.text('ok');
  });
  app.get('/clear', (c) => {
    clearAuthCookie(c);
    return c.text('ok');
  });
  return app;
}

afterEach(() => {
  envState.NODE_ENV = 'test';
});

describe('setAuthCookie — Secure flag', () => {
  it('omits Secure in development', async () => {
    envState.NODE_ENV = 'development';
    const res = await buildApp().request('/set');
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${AUTH_COOKIE_NAME}=token-value`);
    expect(setCookie).not.toContain('Secure');
  });

  it('omits Secure in test', async () => {
    envState.NODE_ENV = 'test';
    const res = await buildApp().request('/set');
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).not.toContain('Secure');
  });

  it('sets Secure in staging', async () => {
    envState.NODE_ENV = 'staging';
    const res = await buildApp().request('/set');
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
  });

  it('sets Secure in production', async () => {
    envState.NODE_ENV = 'production';
    const res = await buildApp().request('/set');
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('Secure');
  });
});
