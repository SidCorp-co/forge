/**
 * Antigravity proxy routes.
 * Proxies calls to the Antigravity service so the web UI doesn't need direct access.
 */
export default {
  routes: [
    {
      method: 'GET',
      path: '/antigravity/projects',
      handler: 'antigravity.listProjects',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'GET',
      path: '/antigravity/agents',
      handler: 'antigravity.listAgents',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'POST',
      path: '/antigravity/projects',
      handler: 'antigravity.createProject',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'DELETE',
      path: '/antigravity/projects/:projectId',
      handler: 'antigravity.deleteProject',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'POST',
      path: '/antigravity/projects/:projectId/test',
      handler: 'antigravity.testConnection',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'GET',
      path: '/antigravity/projects/:projectId/usage',
      handler: 'antigravity.getUsage',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'GET',
      path: '/antigravity/quota',
      handler: 'antigravity.getQuota',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'POST',
      path: '/antigravity/quota/refresh',
      handler: 'antigravity.refreshQuota',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'POST',
      path: '/antigravity/projects/:projectId/sync-skills',
      handler: 'antigravity.syncSkills',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'POST',
      path: '/antigravity/sync-skills-all',
      handler: 'antigravity.syncSkillsToAll',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'POST',
      path: '/antigravity/init',
      handler: 'antigravity.initProject',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'GET',
      path: '/antigravity/init-status/:projectId',
      handler: 'antigravity.initStatus',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
  ],
};
