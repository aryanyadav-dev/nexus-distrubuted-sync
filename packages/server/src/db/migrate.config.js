/* eslint-disable @typescript-eslint/no-var-requires */
// Migration config for node-pg-migrate
const dbUrl = process.env.DATABASE_URL;

if (!dbUrl) {
  console.error("CRITICAL ERROR: 'DATABASE_URL' environment variable is missing completely!");
  console.error("Please verify that you placed 'DATABASE_URL' in the Render Environment Variables tab and spelled it correctly.");
  throw new Error("Missing DATABASE_URL");
}

module.exports = {
  databaseUrl: dbUrl,
  migrationsTable: 'pgmigrations',
  dir: `${__dirname}/../../migrations`,
  direction: 'up',
  verbose: true,
};
