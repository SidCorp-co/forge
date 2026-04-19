export default {
  routes: [
    { method: 'GET', path: '/usage-records', handler: 'usage-record.find', config: { auth: false, policies: ['global::is-forge-project'] } },
    { method: 'GET', path: '/usage-records/summary', handler: 'usage-record.summary', config: { auth: false, policies: ['global::is-forge-project'] } },
    { method: 'POST', path: '/usage-records', handler: 'usage-record.create', config: { auth: false, policies: ['global::is-forge-project'] } },
    { method: 'POST', path: '/usage-records/bulk', handler: 'usage-record.bulkCreate', config: { auth: false, policies: ['global::is-forge-project'] } },
    { method: 'POST', path: '/usage-records/ingest-cli', handler: 'usage-record.ingestCli', config: { auth: false, policies: ['global::is-forge-project'] } },
  ],
};
