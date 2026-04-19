/**
 * Device routes.
 * CRUD + register for user devices.
 * Auth: false + is-forge-project policy (JWT or API key).
 */
export default {
  routes: [
    {
      method: 'GET',
      path: '/devices',
      handler: 'device.find',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'POST',
      path: '/devices/register',
      handler: 'device.register',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'PUT',
      path: '/devices/project-path',
      handler: 'device.setProjectPath',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'PUT',
      path: '/devices/projects-root',
      handler: 'device.setProjectsRoot',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'DELETE',
      path: '/devices/:documentId',
      handler: 'device.deleteDevice',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'PUT',
      path: '/devices/:documentId',
      handler: 'device.updateDevice',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'POST',
      path: '/devices/:documentId/init-project',
      handler: 'device.initProject',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'GET',
      path: '/devices/:documentId/init-status/:projectSlug',
      handler: 'device.initStatus',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'POST',
      path: '/devices/sync-skills',
      handler: 'device.syncSkills',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
  ],
};
