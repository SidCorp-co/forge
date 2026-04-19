/**
 * Agent routes.
 * Authenticated via JWT or API key (is-forge-project policy).
 */
export default {
  routes: [
    {
      method: 'GET',
      path: '/agents',
      handler: 'agent.find',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'GET',
      path: '/agents/:id',
      handler: 'agent.findOne',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'POST',
      path: '/agents',
      handler: 'agent.create',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'PUT',
      path: '/agents/:id',
      handler: 'agent.update',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'DELETE',
      path: '/agents/:id',
      handler: 'agent.delete',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
  ],
};
