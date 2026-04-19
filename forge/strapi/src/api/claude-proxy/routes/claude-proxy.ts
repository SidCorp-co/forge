export default {
  routes: [
    {
      method: 'POST',
      path: '/claude-proxy/run',
      handler: 'claude-proxy.run',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'GET',
      path: '/claude-proxy/status/:sessionId',
      handler: 'claude-proxy.status',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'POST',
      path: '/claude-proxy/resume',
      handler: 'claude-proxy.resume',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
  ],
};
