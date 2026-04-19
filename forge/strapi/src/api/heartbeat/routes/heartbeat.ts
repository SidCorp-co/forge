export default {
  routes: [
    {
      method: 'GET',
      path: '/heartbeat/status',
      handler: 'heartbeat.status',
      config: { policies: [] },
    },
    {
      method: 'POST',
      path: '/heartbeat/tick',
      handler: 'heartbeat.tick',
      config: { policies: [] },
    },
    {
      method: 'GET',
      path: '/heartbeat/history',
      handler: 'heartbeat.history',
      config: { policies: [] },
    },
  ],
};
