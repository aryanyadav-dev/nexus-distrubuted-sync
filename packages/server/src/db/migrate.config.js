/* eslint-disable @typescript-eslint/no-var-requires */
// Migration config for node-pg-migrate
if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
  throw new Error("CRITICAL ERROR: 'DATABASE_URL' is missing! Make sure you are running 'npm run migrate' in the Render 'Start Command' box, NOT the 'Build Command' box!");
}

module.exports = {
  databaseUrl: process.env.DATABASE_URL || 'postgres://dsync:dsync@localhost:5432/dsync',
  migrationsTable: 'pgmigrations',
  dir: `${__dirname}/../../migrations`,
  direction: 'up',
  verbose: true,
};
