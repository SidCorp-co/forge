export default {
  routes: [
    {
      method: 'GET',
      path: '/skill-evals/scorecard',
      handler: 'skill-eval.scorecard',
      config: { auth: false, policies: ['global::is-forge-project'] },
    },
    {
      method: 'GET',
      path: '/skill-evals',
      handler: 'skill-eval.find',
      config: { auth: false, policies: ['global::is-forge-project'] },
    },
    {
      method: 'GET',
      path: '/skill-evals/:id',
      handler: 'skill-eval.findOne',
      config: { auth: false, policies: ['global::is-forge-project'] },
    },
  ],
};
