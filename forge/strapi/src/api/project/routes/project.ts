/**
 * Project routes.
 * Authenticated via JWT or API key (is-forge-project policy).
 */
export default {
  routes: [
    {
      method: 'GET',
      path: '/projects/health',
      handler: 'project.health',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'GET',
      path: '/projects',
      handler: 'project.find',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'GET',
      path: '/projects/:id',
      handler: 'project.findOne',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'POST',
      path: '/projects',
      handler: 'project.create',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'PUT',
      path: '/projects/:id',
      handler: 'project.update',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'DELETE',
      path: '/projects/:id',
      handler: 'project.delete',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
  ],
};
