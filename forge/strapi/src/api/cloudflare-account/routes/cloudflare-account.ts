export default {
  routes: [
    {
      method: 'GET',
      path: '/cloudflare-accounts',
      handler: 'cloudflare-account.find',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'POST',
      path: '/cloudflare-accounts',
      handler: 'cloudflare-account.create',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'PUT',
      path: '/cloudflare-accounts/:documentId',
      handler: 'cloudflare-account.updateAccount',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'DELETE',
      path: '/cloudflare-accounts/:documentId',
      handler: 'cloudflare-account.deleteAccount',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'POST',
      path: '/cloudflare-accounts/:documentId/validate',
      handler: 'cloudflare-account.validate',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    // Cloudflare API proxy routes
    {
      method: 'GET',
      path: '/cloudflare-accounts/:documentId/zones',
      handler: 'cloudflare-account.listZones',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'GET',
      path: '/cloudflare-accounts/:documentId/zones/:zoneId/dns',
      handler: 'cloudflare-account.listDns',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'POST',
      path: '/cloudflare-accounts/:documentId/zones/:zoneId/dns',
      handler: 'cloudflare-account.createDns',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'PUT',
      path: '/cloudflare-accounts/:documentId/zones/:zoneId/dns/:recordId',
      handler: 'cloudflare-account.updateDns',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'DELETE',
      path: '/cloudflare-accounts/:documentId/zones/:zoneId/dns/:recordId',
      handler: 'cloudflare-account.deleteDns',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'POST',
      path: '/cloudflare-accounts/:documentId/zones/:zoneId/purge',
      handler: 'cloudflare-account.purgeCache',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
  ],
};
