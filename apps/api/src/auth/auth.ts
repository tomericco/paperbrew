import { betterAuth } from 'better-auth';
import { config } from '../config.js';
import { pool } from '../db/client.js';
import { socialProviders } from './providers.js';
import { provisionUser } from './provision.js';

// Better Auth runs on our Postgres pool in its own auth_* tables (see db/schema.sql).
// Its routes live under /api/auth on the web origin; the web app proxies them here with the prefix kept.
export const auth = betterAuth({
  database: pool,
  basePath: '/api/auth',
  secret: config.BETTER_AUTH_SECRET,
  baseURL: config.BETTER_AUTH_URL,
  trustedOrigins: [config.BETTER_AUTH_URL],
  socialProviders: socialProviders(process.env),
  user: { modelName: 'auth_users' },
  session: { modelName: 'auth_sessions' },
  account: { modelName: 'auth_accounts' },
  verification: { modelName: 'auth_verifications' },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          await provisionUser({ id: user.id, email: user.email });
        },
      },
    },
  },
});
