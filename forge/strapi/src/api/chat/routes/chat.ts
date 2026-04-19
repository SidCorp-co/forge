export default {
  routes: [
    {
      method: 'POST',
      path: '/chat',
      handler: 'chat.send',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
  ],
};
