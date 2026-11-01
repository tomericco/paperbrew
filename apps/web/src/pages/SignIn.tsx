import { useEffect, useState } from 'react';
import { authClient } from '../auth';
import { Layout } from '../Layout';

type Provider = 'google' | 'github' | 'reddit';

const LABELS: Record<Provider, string> = {
  google: 'Google',
  github: 'GitHub',
  reddit: 'Reddit',
};

export function SignIn() {
  // null while loading
  const [providers, setProviders] = useState<Provider[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/providers')
      .then((res) => (res.ok ? res.json() : { providers: [] }))
      .then((body: { providers: Provider[] }) => {
        if (!cancelled) setProviders(body.providers);
      })
      .catch(() => {
        if (!cancelled) setProviders([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Layout>
      <div className="grid">
        <section className="card span-center">
          <h1>Sign in</h1>
          {providers === null ? (
            <p className="muted">Loading…</p>
          ) : providers.length === 0 ? (
            <p className="muted">Sign-in isn't set up yet.</p>
          ) : (
            <ul className="providers">
              {providers.map((provider) => (
                <li key={provider}>
                  <button
                    type="button"
                    className="btn btn-block"
                    onClick={() => authClient.signIn.social({ provider, callbackURL: '/app' })}
                  >
                    Continue with {LABELS[provider]}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Layout>
  );
}
