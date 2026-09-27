// Starts embedded-postgres as a long-running daemon for local E2E tests.
const EmbeddedPostgres = require('embedded-postgres').default;
const pg = new EmbeddedPostgres({
  databaseDir: '/tmp/wb-test-db',
  user: 'postgres',
  password: 'postgres',
  port: 5433,
  persistent: false,
});
pg.initialise()
  .then(() => pg.start())
  .then(() => pg.createDatabase('weildbuild'))
  .then(() => {
    console.log('embedded postgres ready on :5433');
    // keep alive
    setInterval(() => {}, 1 << 30);
  })
  .catch((e) => {
    console.error('FAIL:', e.message);
    process.exit(1);
  });
