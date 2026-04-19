export default {
  routes: [
    { method: 'GET', path: '/eval-runs', handler: 'eval-run.find', config: { auth: false, policies: ['global::is-forge-project'] } },
    { method: 'GET', path: '/eval-runs/:id', handler: 'eval-run.findOne', config: { auth: false, policies: ['global::is-forge-project'] } },
    { method: 'POST', path: '/eval-runs', handler: 'eval-run.create', config: { auth: false, policies: ['global::is-forge-project'] } },
  ],
};
