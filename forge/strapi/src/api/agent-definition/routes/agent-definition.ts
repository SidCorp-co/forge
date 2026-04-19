export default {
  routes: [
    {
      method: 'GET',
      path: '/agent-definitions',
      handler: 'agent-definition.find',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'GET',
      path: '/agent-definitions/:id',
      handler: 'agent-definition.findOne',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'POST',
      path: '/agent-definitions',
      handler: 'agent-definition.create',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'PUT',
      path: '/agent-definitions/:id',
      handler: 'agent-definition.update',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'DELETE',
      path: '/agent-definitions/:id',
      handler: 'agent-definition.delete',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
  ],
};
