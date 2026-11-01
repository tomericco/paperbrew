import { z } from 'zod';

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(8787),
  // Address template, e.g. "{token}@save.example.com" or "a1b2c3+{token}@inbound.postmarkapp.com".
  INBOUND_ADDRESS: z
    .string()
    .min(3)
    .transform((a) => a.toLowerCase())
    .refine((a) => a.split('{token}').length === 2, 'INBOUND_ADDRESS must contain {token} exactly once'),
  POSTMARK_WEBHOOK_USER: z.string().min(1),
  POSTMARK_WEBHOOK_PASSWORD: z.string().min(16),
  REQUIRE_KNOWN_SENDER: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  FETCH_TIMEOUT_MS: z.coerce.number().default(15_000),
  FETCH_MAX_BYTES: z.coerce.number().default(5_000_000),
  // Required for GET /cron/run-jobs; without it the endpoint always answers 401.
  CRON_SECRET: z
    .string()
    .optional()
    .transform((v) => v || undefined),
});

export type Config = z.infer<typeof Env>;
export const config: Config = Env.parse({
  ...process.env,
  // The Supabase–Vercel integration sets POSTGRES_URL.
  DATABASE_URL: process.env.DATABASE_URL || process.env.POSTGRES_URL,
});
