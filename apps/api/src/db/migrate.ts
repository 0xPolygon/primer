import '../env.ts';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const isTest = process.argv.includes('test');
const url = isTest ? process.env.DATABASE_URL_TEST : process.env.DATABASE_URL;
if (!url) {
  throw new Error(`${isTest ? 'DATABASE_URL_TEST' : 'DATABASE_URL'} is required`);
}

// Resolve drizzle/ relative to this file so the script works regardless of cwd.
const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, '../../drizzle');

const migrationClient = postgres(url, { max: 1 });
const db = drizzle(migrationClient);

await migrate(db, { migrationsFolder });
console.log('Migrations applied.');
await migrationClient.end();
