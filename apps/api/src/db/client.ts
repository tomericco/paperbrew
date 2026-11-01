import { attachDatabasePool } from '@vercel/functions';
import pg from 'pg';
import { config } from '../config.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function connection(url: string): pg.PoolConfig {
  const parsed = new URL(url);
  if (LOCAL_HOSTS.has(parsed.hostname)) return { connectionString: url };
  parsed.searchParams.delete('sslmode');
  // pg treats sslmode=require as full verification, which fails on Supabase's CA; encrypt without verifying.
  return { connectionString: parsed.toString(), ssl: { rejectUnauthorized: false } };
}

const onVercel = Boolean(process.env.VERCEL);

export const pool = new pg.Pool({ ...connection(config.DATABASE_URL), max: onVercel ? 3 : 10 });

// Lets Vercel close idle connections before it suspends the function instance.
if (onVercel) attachDatabasePool(pool);

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
