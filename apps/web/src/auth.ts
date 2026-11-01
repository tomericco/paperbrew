import { createAuthClient } from 'better-auth/react';

// Same-origin: talks to /api/auth, which is proxied to Better Auth on the API.
export const authClient = createAuthClient();
