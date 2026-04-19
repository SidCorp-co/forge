export default {
  routes: [
    {
      method: 'POST',
      path: '/knowledge/ingest',
      handler: 'knowledge.ingest',
      config: { auth: false },
    },
    {
      method: 'DELETE',
      path: '/knowledge/:docId',
      handler: 'knowledge.remove',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/knowledge/search',
      handler: 'knowledge.search',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/knowledge/sync',
      handler: 'knowledge.sync',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/knowledge/backfill',
      handler: 'knowledge.backfill',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/knowledge/health',
      handler: 'knowledge.health',
      config: { auth: false },
    },
  ],
};
