import '../env.ts';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const isTest = process.argv.includes('test');
const url = isTest ? process.env.DATABASE_URL_TEST : process.env.DATABASE_URL;
if (!url) {
  throw new Error(`${isTest ? 'DATABASE_URL_TEST' : 'DATABASE_URL'} is required`);
}

const migrationClient = postgres(url, { max: 1 });
const db = drizzle(migrationClient);

await migrate(db, { migrationsFolder: './drizzle' });
console.log('Migrations applied.');
await migrationClient.end();
