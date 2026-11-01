import { describe, expect, it } from 'vitest';
import { accountEmail, enabledProviders, placeholderEmail, socialProviders } from '../src/auth/providers.js';

describe('enabledProviders', () => {
  it('is empty without env vars', () => {
    expect(enabledProviders({})).toEqual([]);
  });

  it('needs both the client id and the secret', () => {
    expect(enabledProviders({ GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'y', GOOGLE_CLIENT_ID: 'x' })).toEqual([
      'github',
    ]);
  });

  it('ignores empty values', () => {
    expect(enabledProviders({ GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: '' })).toEqual([]);
  });

  it('lists every configured provider in a stable order', () => {
    const env = {
      REDDIT_CLIENT_ID: 'r',
      REDDIT_CLIENT_SECRET: 'r',
      GITHUB_CLIENT_ID: 'g',
      GITHUB_CLIENT_SECRET: 'g',
      GOOGLE_CLIENT_ID: 'o',
      GOOGLE_CLIENT_SECRET: 'o',
    };
    expect(enabledProviders(env)).toEqual(['google', 'github', 'reddit']);
  });
});

describe('socialProviders', () => {
  it('only includes configured providers', () => {
    expect(Object.keys(socialProviders({ REDDIT_CLIENT_ID: 'x', REDDIT_CLIENT_SECRET: 'y' }))).toEqual(['reddit']);
  });

  it('passes the client id and secret through', () => {
    const providers = socialProviders({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' });
    expect(providers.google).toMatchObject({ clientId: 'id', clientSecret: 'secret' });
  });

  it('gives Reddit users a placeholder email', async () => {
    const reddit = socialProviders({ REDDIT_CLIENT_ID: 'x', REDDIT_CLIENT_SECRET: 'y' }).reddit as {
      mapProfileToUser: (profile: { id: string; name: string }) => Promise<{ email?: string | null }>;
    };
    const mapped = await reddit.mapProfileToUser({ id: 'Abc123', name: 'someone' });
    expect(mapped.email).toBe('reddit-abc123@users.paperbrew.invalid');
  });
});

describe('placeholderEmail', () => {
  it('builds a lowercase, non-routable address', () => {
    expect(placeholderEmail('reddit', 'T2_Abc')).toBe('reddit-t2_abc@users.paperbrew.invalid');
  });
});

describe('accountEmail', () => {
  it('drops placeholder emails', () => {
    expect(accountEmail('reddit-t2_abc@users.paperbrew.invalid')).toBeNull();
  });

  it('drops any .invalid address, including Better Auth fallbacks', () => {
    expect(accountEmail('123@github.placeholder.invalid')).toBeNull();
  });

  it('lowercases and trims real emails', () => {
    expect(accountEmail('Me@Gmail.com')).toBe('me@gmail.com');
    expect(accountEmail('  me@example.com ')).toBe('me@example.com');
  });
});
