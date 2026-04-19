export default {
  routes: [
    {
      method: 'GET',
      path: '/chat-logs/recent',
      handler: 'chat-log.recent',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/chat-logs/flagged',
      handler: 'chat-log.flagged',
      config: {
        policies: ['global::is-forge-project'],
        auth: false,
      },
    },
    {
      method: 'GET',
      path: '/chat-logs',
      handler: 'chat-log.find',
      config: {
        policies: ['global::is-forge-project'],
        auth: false,
      },
    },
    {
      method: 'GET',
      path: '/chat-logs/:id',
      handler: 'chat-log.findOne',
      config: {
        policies: ['global::is-forge-project'],
        auth: false,
      },
    },
    {
      method: 'PATCH',
      path: '/chat-logs/:id',
      handler: 'chat-log.update',
      config: {
        policies: ['global::is-forge-project'],
        auth: false,
      },
    },
    {
      method: 'DELETE',
      path: '/chat-logs/:id',
      handler: 'chat-log.delete',
      config: {
        policies: ['global::is-forge-project'],
        auth: false,
      },
    },
  ],
};
