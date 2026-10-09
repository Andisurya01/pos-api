import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection URL'),
  /** Signs access tokens. Generated per installation by the installer. */
  JWT_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  /** Session ends after this long without a token refresh (docs/alur/02). */
  SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(30),
  /** Hard cap on one login, refreshes included. */
  SESSION_MAX_HOURS: z.coerce.number().int().positive().default(16),
});

export type Env = z.infer<typeof envSchema>;

/** Used by ConfigModule: the app refuses to start with a bad environment. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid environment variables:\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}
