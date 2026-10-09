// Applies migrations to the test database (TEST_DATABASE_URL) instead of pos_dev.
import { spawnSync } from 'node:child_process';

try {
  process.loadEnvFile();
} catch {
  // no .env file: variables come from the shell
}

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error('TEST_DATABASE_URL is not set');
  process.exit(1);
}

const result = spawnSync('pnpm', ['exec', 'drizzle-kit', 'migrate'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, DATABASE_URL: url },
});
process.exit(result.status ?? 1);
