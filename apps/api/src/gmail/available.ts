type Env = Record<string, string | undefined>;

/** Gmail sync needs a token-encryption key and the Google OAuth client; without all three the UI hides it. */
export function gmailAvailable(env: Env): boolean {
  return Boolean(env.GMAIL_TOKEN_KEY && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}
