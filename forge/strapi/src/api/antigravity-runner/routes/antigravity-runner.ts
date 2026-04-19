export default {
  routes: [
    {
      method: 'GET',
      path: '/antigravity-runners',
      handler: 'antigravity-runner.find',
      config: { auth: false, policies: ['global::is-forge-project'] },
    },
    {
      method: 'POST',
      path: '/antigravity-runners/sync-agents',
      handler: 'antigravity-runner.syncAgents',
      config: { auth: false, policies: ['global::is-forge-project'] },
    },
    {
      method: 'GET',
      path: '/antigravity-runners/:id',
      handler: 'antigravity-runner.findOne',
      config: { auth: false, policies: ['global::is-forge-project'] },
    },
    {
      method: 'POST',
      path: '/antigravity-runners',
      handler: 'antigravity-runner.create',
      config: { auth: false, policies: ['global::is-forge-project'] },
    },
    {
      method: 'PUT',
      path: '/antigravity-runners/:id',
      handler: 'antigravity-runner.update',
      config: { auth: false, policies: ['global::is-forge-project'] },
    },
    {
      method: 'DELETE',
      path: '/antigravity-runners/:id',
      handler: 'antigravity-runner.delete',
      config: { auth: false, policies: ['global::is-forge-project'] },
    },
    {
      method: 'POST',
      path: '/antigravity-runners/:id/health-check',
      handler: 'antigravity-runner.healthCheck',
      config: { auth: false, policies: ['global::is-forge-project'] },
    },
    {
      method: 'GET',
      path: '/antigravity-runners/:id/quota',
      handler: 'antigravity-runner.getQuota',
      config: { auth: false, policies: ['global::is-forge-project'] },
    },
    {
      method: 'POST',
      path: '/antigravity-runners/:id/quota/refresh',
      handler: 'antigravity-runner.refreshQuota',
      config: { auth: false, policies: ['global::is-forge-project'] },
    },
    {
      method: 'GET',
      path: '/antigravity-runners/:id/projects',
      handler: 'antigravity-runner.listRunnerProjects',
      config: { auth: false, policies: ['global::is-forge-project'] },
    },
    {
      method: 'POST',
      path: '/antigravity-runners/:id/exclude',
      handler: 'antigravity-runner.exclude',
      config: { auth: false, policies: ['global::is-forge-project'] },
    },
    {
      method: 'POST',
      path: '/antigravity-runners/:id/include',
      handler: 'antigravity-runner.include',
      config: { auth: false, policies: ['global::is-forge-project'] },
    },
    {
      method: 'POST',
      path: '/antigravity-runners/:id/clear-depleted',
      handler: 'antigravity-runner.clearDepletedModels',
      config: { auth: false, policies: ['global::is-forge-project'] },
    },
    {
      method: 'POST',
      path: '/antigravity-runners/:id/clear-pause',
      handler: 'antigravity-runner.clearPause',
      config: { auth: false, policies: ['global::is-forge-project'] },
    },
  ],
};
