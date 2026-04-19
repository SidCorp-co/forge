/**
 * Issue routes.
 * Authenticated via JWT or API key (is-forge-project policy).
 */
export default {
  routes: [
    {
      method: 'GET',
      path: '/issues',
      handler: 'issue.find',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'GET',
      path: '/issues/pipeline-timing',
      handler: 'issue.pipelineTiming',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'GET',
      path: '/issues/:id',
      handler: 'issue.findOne',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'POST',
      path: '/issues',
      handler: 'issue.create',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'GET',
      path: '/issues/:id/cost-summary',
      handler: 'issue.costSummary',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'POST',
      path: '/issues/:id/enrich',
      handler: 'issue.enrich',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'POST',
      path: '/issues/backfill-session-context',
      handler: 'issue.backfillSessionContext',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'PUT',
      path: '/issues/:id',
      handler: 'issue.update',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'DELETE',
      path: '/issues/:id',
      handler: 'issue.delete',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
  ],
};
