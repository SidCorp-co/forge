export default {
  routes: [
    {
      method: 'GET',
      path: '/notifications',
      handler: 'notification.find',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'GET',
      path: '/notifications/unread-count',
      handler: 'notification.unreadCount',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'GET',
      path: '/notifications/:id',
      handler: 'notification.findOne',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'PUT',
      path: '/notifications/:id',
      handler: 'notification.update',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'POST',
      path: '/notifications/mark-all-read',
      handler: 'notification.markAllRead',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'DELETE',
      path: '/notifications/:id',
      handler: 'notification.delete',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
  ],
};
