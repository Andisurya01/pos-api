import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

try {
  process.loadEnvFile();
} catch {
  // no .env file: variables come from the shell
}

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // e2e tests always hit the test database, never pos_dev.
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? '' },
    // Files share one database; run them one after another.
    fileParallelism: false,
  },
});
