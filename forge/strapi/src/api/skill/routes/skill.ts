export default {
  routes: [
    // External skill push endpoints — relay to runners without storing in Forge
    // Listed first so they match before the generic POST /skills route
    {
      method: 'POST',
      path: '/skills/push-antigravity',
      handler: 'skill.pushAntigravity',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'POST',
      path: '/skills/push-claude',
      handler: 'skill.pushClaude',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'POST',
      path: '/skills/sync-status',
      handler: 'skill.syncStatus',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'POST',
      path: '/skills/bulk-push',
      handler: 'skill.bulkPush',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    // Core CRUD routes
    {
      method: 'GET',
      path: '/skills',
      handler: 'skill.find',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'GET',
      path: '/skills/:id',
      handler: 'skill.findOne',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'POST',
      path: '/skills',
      handler: 'skill.create',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'PUT',
      path: '/skills/:id',
      handler: 'skill.update',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'DELETE',
      path: '/skills/:id',
      handler: 'skill.delete',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
  ],
};
