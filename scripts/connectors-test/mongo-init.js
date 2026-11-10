/* global db */ // mongosh provides `db` in init scripts
// A read-only monitoring user, as recommended in the docs.
db.getSiblingDB('admin').createUser({
  user: 'monitor',
  pwd: 'test-monitor',
  roles: [{ role: 'clusterMonitor', db: 'admin' }],
});
db.getSiblingDB('events').items.insertMany([{ n: 1 }, { n: 2 }, { n: 3 }]);
