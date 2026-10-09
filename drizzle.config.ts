import { defineConfig } from 'drizzle-kit';

// drizzle-kit does not read .env by itself. Missing file = variables come from the shell (CI, server).
try {
  process.loadEnvFile();
} catch {
  // no .env file
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema/index.ts',
  out: './drizzle',
  casing: 'snake_case',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  strict: true,
  verbose: true,
});
