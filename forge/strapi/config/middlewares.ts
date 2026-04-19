import type { Core } from '@strapi/strapi';

const config: Core.Config.Middlewares = [
  'strapi::logger',
  'strapi::errors',
  'strapi::security',
  {
    name: 'strapi::cors',
    config: {
      origin(ctx) {
        const requestOrigin = ctx.request.header.origin || '';
        // CORS_ORIGIN_PATTERNS: comma-separated regex patterns (e.g. "^https://([a-z0-9-]+\\.)*example\\.com$")
        const patterns = (process.env.CORS_ORIGIN_PATTERNS || '')
          .split(',').map(s => s.trim()).filter(Boolean)
          .map(p => new RegExp(p));
        if (patterns.some(p => p.test(requestOrigin))) return requestOrigin;
        const whitelist = [
          'http://localhost:1337', 'http://localhost:1420', 'http://localhost:3000', 'http://localhost:3001',
          'https://tauri.localhost', 'http://tauri.localhost', 'tauri://localhost',
          ...(process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',').map(s => s.trim()) : []),
        ];
        // Allow any origin for widget/chat endpoints authenticated via API key
        const isWidgetRoute = ctx.request.path.startsWith('/api/widget/') || ctx.request.path.startsWith('/api/chat');
        if (isWidgetRoute && ctx.request.header['x-forge-api-key']) return requestOrigin;
        return whitelist.includes(requestOrigin) ? requestOrigin : whitelist[0];
      },
      headers: ['Content-Type', 'Authorization', 'X-Forge-API-Key'],
    },
  },
  'strapi::poweredBy',
  'strapi::query',
  'strapi::body',
  'strapi::session',
  'strapi::favicon',
  'strapi::public',
  'global::forge-api-key',
];

export default config;
