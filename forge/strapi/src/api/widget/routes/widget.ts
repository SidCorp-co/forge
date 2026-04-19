export default {
  routes: [
    {
      method: 'GET',
      path: '/widget/:slug/forge-widget.js',
      handler: 'widget.serve',
      config: { auth: false },
    },
  ],
};
