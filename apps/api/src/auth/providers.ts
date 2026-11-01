// Pure: which social sign-in providers are configured, and how provider emails map to ours.
// No config or DB imports, so it's testable without mocks.
import type { SocialProviders } from 'better-auth';

export type ProviderId = 'google' | 'github' | 'reddit';

type Env = Record<string, string | undefined>;

const PROVIDERS: ReadonlyArray<{ id: ProviderId; prefix: string }> = [
  { id: 'google', prefix: 'GOOGLE' },
  { id: 'github', prefix: 'GITHUB' },
  { id: 'reddit', prefix: 'REDDIT' },
];

/** RFC 6761 reserves .invalid, so these addresses can never receive mail. */
const PLACEHOLDER_DOMAIN = 'users.paperbrew.invalid';

function credentials(env: Env, prefix: string): { clientId: string; clientSecret: string } | null {
  const clientId = env[`${prefix}_CLIENT_ID`];
  const clientSecret = env[`${prefix}_CLIENT_SECRET`];
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** Providers with both a client id and a secret set, in display order. */
export function enabledProviders(env: Env): ProviderId[] {
  return PROVIDERS.filter((p) => credentials(env, p.prefix)).map((p) => p.id);
}

/** Better Auth `socialProviders` with only the configured providers. */
export function socialProviders(env: Env): SocialProviders {
  const result: SocialProviders = {};
  const google = credentials(env, 'GOOGLE');
  if (google) result.google = google;
  const github = credentials(env, 'GITHUB');
  if (github) result.github = github;
  const reddit = credentials(env, 'REDDIT');
  if (reddit) {
    result.reddit = {
      ...reddit,
      // Reddit's /api/v1/me never returns an email; Better Auth needs a unique one per user.
      mapProfileToUser: (profile) => ({ email: placeholderEmail('reddit', profile.id) }),
    };
  }
  return result;
}

/** Stable, non-routable auth email for a provider account without one. */
export function placeholderEmail(provider: string, id: string): string {
  return `${provider}-${id}@${PLACEHOLDER_DOMAIN}`.toLowerCase();
}

/**
 * The email we store on `users`: lowercased, or null for placeholders.
 * Any `.invalid` address is a placeholder, ours or Better Auth's own fallback (`<id>@<provider>.placeholder.invalid`).
 */
export function accountEmail(authEmail: string): string | null {
  const email = authEmail.trim().toLowerCase();
  return email.endsWith('.invalid') ? null : email;
}
