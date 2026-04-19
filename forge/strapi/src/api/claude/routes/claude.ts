/**
 * Claude CLI proxy routes.
 * Auth: is-forge-project policy (JWT or API key).
 */
export default {
  routes: [
    {
      method: 'POST',
      path: '/claude/run',
      handler: 'claude.run',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'GET',
      path: '/claude/status/:id',
      handler: 'claude.status',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
  ],
};
