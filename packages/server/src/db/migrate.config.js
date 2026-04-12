/* eslint-disable @typescript-eslint/no-var-requires */
// Migration config for node-pg-migrate
module.exports = {
  databaseUrl: process.env.DATABASE_URL || 'postgres://dsync:dsync@localhost:5432/dsync',
  migrationsTable: 'pgmigrations',
  dir: `${__dirname}/../../migrations`,
  direction: 'up',
  verbose: true,
};
