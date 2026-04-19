export default {
  routes: [
    {
      method: 'GET',
      path: '/memories',
      handler: 'memory.list',
      config: { policies: [] },
    },
    {
      method: 'DELETE',
      path: '/memories/:sourceId',
      handler: 'memory.remove',
      config: { policies: [] },
    },
    {
      method: 'POST',
      path: '/memories/add',
      handler: 'memory.add',
      config: { policies: [] },
    },
    {
      method: 'POST',
      path: '/memories/search',
      handler: 'memory.search',
      config: { policies: [] },
    },
    {
      method: 'POST',
      path: '/memories/dream',
      handler: 'memory.dream',
      config: { policies: [] },
    },
  ],
};
