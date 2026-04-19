export default {
  routes: [
    {
      method: 'POST',
      path: '/token/generate',
      handler: 'token.generate',
      config: {
        auth: false,
      },
    },
  ],
};
