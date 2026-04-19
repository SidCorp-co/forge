export default {
  routes: [
    {
      method: 'GET',
      path: '/labels',
      handler: 'label.find',
      config: { auth: false, policies: ['global::is-forge-project'] },
    },
    {
      method: 'POST',
      path: '/labels',
      handler: 'label.create',
      config: { auth: false, policies: ['global::is-forge-project'] },
    },
    {
      method: 'PUT',
      path: '/labels/:id',
      handler: 'label.update',
      config: { auth: false, policies: ['global::is-forge-project'] },
    },
    {
      method: 'DELETE',
      path: '/labels/:id',
      handler: 'label.delete',
      config: { auth: false, policies: ['global::is-forge-project'] },
    },
  ],
};
