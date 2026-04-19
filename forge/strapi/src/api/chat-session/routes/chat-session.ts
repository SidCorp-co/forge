/**
 * Chat session routes.
 * - CRUD: authenticated OR widget (API key) — auth: false + is-forge-project policy
 * - Delete: authenticated only
 */
export default {
  routes: [
    {
      method: 'GET',
      path: '/chat-sessions',
      handler: 'chat-session.find',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'GET',
      path: '/chat-sessions/:id',
      handler: 'chat-session.findOne',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'POST',
      path: '/chat-sessions',
      handler: 'chat-session.create',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'PUT',
      path: '/chat-sessions/:id',
      handler: 'chat-session.update',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'DELETE',
      path: '/chat-sessions/:id',
      handler: 'chat-session.delete',
      config: {
        policies: ['global::is-authenticated'],
      },
    },
  ],
};
