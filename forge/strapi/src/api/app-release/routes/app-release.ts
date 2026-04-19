export default {
  routes: [
    // Tauri updater check — public, no auth
    {
      method: 'GET',
      path: '/app-releases/check/:target/:currentVersion',
      handler: 'app-release.check',
      config: { auth: false },
    },
    // Binary download — public, no auth
    {
      method: 'GET',
      path: '/app-releases/download/:documentId',
      handler: 'app-release.download',
      config: { auth: false },
    },
    // Latest releases for all platforms — public, no auth
    {
      method: 'GET',
      path: '/app-releases/latest',
      handler: 'app-release.latest',
      config: { auth: false },
    },
    // CRUD routes for authenticated users (admin upload)
    {
      method: 'GET',
      path: '/app-releases',
      handler: 'app-release.find',
    },
    {
      method: 'GET',
      path: '/app-releases/:id',
      handler: 'app-release.findOne',
    },
    {
      method: 'POST',
      path: '/app-releases',
      handler: 'app-release.create',
    },
    {
      method: 'PUT',
      path: '/app-releases/:id',
      handler: 'app-release.update',
    },
    {
      method: 'DELETE',
      path: '/app-releases/:id',
      handler: 'app-release.delete',
    },
  ],
};
