export default {
  routes: [
    {
      method: 'GET',
      path: '/activities',
      handler: 'activity.find',
      config: { auth: false, policies: ['global::is-forge-project'] },
    },
    {
      method: 'PUT',
      path: '/activities/:documentId/evaluate',
      handler: 'activity.evaluate',
      config: { auth: false },
    },
    {
      method: 'DELETE',
      path: '/activities/:documentId',
      handler: 'activity.delete',
      config: { auth: false },
    },
  ],
};
