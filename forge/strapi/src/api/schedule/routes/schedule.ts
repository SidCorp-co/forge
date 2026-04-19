export default {
  routes: [
    {
      method: 'GET',
      path: '/schedules',
      handler: 'schedule.find',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'GET',
      path: '/schedules/:id',
      handler: 'schedule.findOne',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'POST',
      path: '/schedules',
      handler: 'schedule.create',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'PUT',
      path: '/schedules/:id',
      handler: 'schedule.update',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'DELETE',
      path: '/schedules/:id',
      handler: 'schedule.delete',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
    {
      method: 'POST',
      path: '/schedules/:id/run',
      handler: 'schedule.run',
      config: {
        auth: false,
        policies: ['global::is-forge-project'],
      },
    },
  ],
};
