import { z } from 'zod';

// String env vars only ever arrive as strings (or are absent) — never real
// booleans. z.coerce.boolean() runs JS's Boolean(str) under the hood, and
// Boolean('false') is `true` (any non-empty string is truthy). That meant
// no string value could ever produce `false` for a boolean env flag,
// silently, for every field using it below. Compare against the literal
// string instead.
function booleanFromEnv(defaultValue: boolean) {
  return z
    .string()
    .optional()
    .transform((val) => (val === undefined ? defaultValue : val.toLowerCase() === 'true'));
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  API_PREFIX: z.string().default('/api/v1'),
  WS_PATH: z.string().default('/ws'),
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_SIZE: z.coerce.number().int().positive().default(10),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRY: z.string().default('15m'),
  JWT_REFRESH_EXPIRY: z.string().default('30d'),
  JWT_ISSUER: z.string().default('socialplay'),
  JWT_AUDIENCE: z.string().default('socialplay'),
  // W-0 security step-up: AES-256-GCM key for encrypting TOTP shared
  // secrets at rest (64 hex chars = 32 bytes). Deliberately OPTIONAL so
  // that existing environments and the existing test suite keep booting
  // unchanged; the TOTP subsystem itself fails closed with a clear error
  // when it is unset, rather than silently storing secrets in plaintext.
  SECURITY_TOTP_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters (32 bytes)')
    .optional(),


  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: booleanFromEnv(false),
  COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  CORS_CREDENTIALS: booleanFromEnv(true),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_AUTH_WINDOW_MS: z.coerce.number().int().positive().default(900000),
  RATE_LIMIT_AUTH_MAX_REQUESTS: z.coerce.number().int().positive().default(10),
  STORAGE_PROVIDER: z.enum(['local', 's3', 'r2', 'minio']).default('local'),
  STORAGE_LOCAL_PATH: z.string().default('./uploads'),
  STORAGE_S3_ENDPOINT: z.string().url().optional(),
  STORAGE_S3_REGION: z.string().optional(),
  STORAGE_S3_BUCKET: z.string().optional(),
  STORAGE_S3_ACCESS_KEY: z.string().optional(),
  STORAGE_S3_SECRET_KEY: z.string().optional(),
  STORAGE_S3_PUBLIC_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.coerce.number().int().nonnegative().default(0),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: booleanFromEnv(true),
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),
  EMAIL_PROVIDER: z.enum(['smtp', 'sendgrid', 'mailgun', 'console']).default('console'),
  EMAIL_SMTP_HOST: z.string().optional(),
  EMAIL_SMTP_PORT: z.coerce.number().int().positive().optional(),
  EMAIL_SMTP_USER: z.string().optional(),
  EMAIL_SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().email().default('noreply@socialplay.local'),
  PUSH_VAPID_PUBLIC_KEY: z.string().optional(),
  PUSH_VAPID_PRIVATE_KEY: z.string().optional(),
  PUSH_VAPID_SUBJECT: z.string().optional(),
});

export type EnvConfig = z.infer<typeof envSchema>;

let cachedConfig: EnvConfig | null = null;

export function getConfig(): EnvConfig {
  if (cachedConfig) {
    return cachedConfig;
  }
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const errors = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${errors}`);
  }
  cachedConfig = result.data;
  return cachedConfig;
}

export function resetConfig(): void {
  cachedConfig = null;
}

export const config = getConfig();