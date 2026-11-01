import { useEffect, useState } from 'react';
import { authClient } from '../auth';

type Me = { address: string; token: string; email: string | null };

type Article = {
  id: string;
  title: string | null;
  siteName: string | null;
  sourceUrl: string | null;
  status: 'pending' | 'ready' | 'failed';
  wordCount: number | null;
  createdAt: string;
};

async function errorText(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

export function Library() {
  const { data: session, isPending } = authClient.useSession();

  useEffect(() => {
    if (!isPending && !session) location.replace('/signin');
  }, [isPending, session]);

  if (isPending || !session) return <p>Loading…</p>;
  return <LibraryContent />;
}

function LibraryContent() {
  const [me, setMe] = useState<Me | null>(null);
  const [articles, setArticles] = useState<Article[] | null>(null);
  const [loadError, setLoadError] = useState('');

  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState('');
  const [addressMessage, setAddressMessage] = useState('');

  const [brewing, setBrewing] = useState(false);
  const [brewError, setBrewError] = useState('');

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetch('/api/me'), fetch('/api/articles')])
      .then(async ([meRes, articlesRes]) => {
        if (meRes.status === 401 || articlesRes.status === 401) {
          location.replace('/signin');
          return;
        }
        if (!meRes.ok || !articlesRes.ok) throw new Error('Could not load your library.');
        const meBody = (await meRes.json()) as Me;
        const articlesBody = (await articlesRes.json()) as { articles: Article[] };
        if (cancelled) return;
        setMe(meBody);
        setToken(meBody.token);
        setArticles(articlesBody.articles);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Could not load your library.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveAddress() {
    setAddressMessage('');
    try {
      const res = await fetch('/api/me/address', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        setAddressMessage(await errorText(res, 'Could not change the address.'));
        return;
      }
      const body = (await res.json()) as { address: string; token: string };
      setMe((prev) => (prev ? { ...prev, address: body.address, token: body.token } : prev));
      setToken(body.token);
      setEditing(false);
      setAddressMessage(`Address changed to ${body.address}`);
    } catch {
      setAddressMessage('Could not change the address.');
    }
  }

  async function brew() {
    setBrewing(true);
    setBrewError('');
    try {
      const res = await fetch('/api/brew');
      if (!res.ok) {
        setBrewError(await errorText(res, 'Brewing failed.'));
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get('content-disposition') ?? '';
      const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? 'paperbrew.pdf';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Safari can cancel the download if the URL is revoked in the same task as the click.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      setBrewError('Brewing failed.');
    } finally {
      setBrewing(false);
    }
  }

  async function signOut() {
    await authClient.signOut();
    location.assign('/');
  }

  async function remove(id: string) {
    try {
      const res = await fetch(`/api/articles/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (res.ok || res.status === 404) setArticles((prev) => prev?.filter((a) => a.id !== id) ?? prev);
    } catch {
      // leave the row; the user can retry
    }
  }

  if (loadError) return <p>{loadError}</p>;
  if (!me || !articles) return <p>Loading…</p>;

  return (
    <main>
      <h1>Your library</h1>

      <p>
        Forward articles to: <code>{me.address}</code>{' '}
        <button type="button" onClick={() => setEditing((v) => !v)}>
          Change
        </button>
      </p>
      {editing && (
        <p>
          <input value={token} onChange={(e) => setToken(e.target.value)} aria-label="Address name" />{' '}
          <button type="button" onClick={saveAddress}>
            Save
          </button>
        </p>
      )}
      {addressMessage && <p role="status">{addressMessage}</p>}

      <p>
        <button type="button" onClick={brew} disabled={brewing}>
          {brewing ? 'Brewing…' : 'Brew'}
        </button>
        {brewError && <span role="alert"> {brewError}</span>}
      </p>

      <p>
        <button type="button" onClick={signOut}>
          Sign out
        </button>
      </p>

      {articles.length === 0 ? (
        <p>No articles yet. Forward an email with a link to the address above.</p>
      ) : (
        <ul>
          {articles.map((article) => (
            <li key={article.id}>
              {article.sourceUrl ? (
                <a href={article.sourceUrl}>{article.title ?? article.sourceUrl}</a>
              ) : (
                (article.title ?? 'Untitled')
              )}
              {article.siteName && ` · ${article.siteName}`} · {article.status}{' '}
              <button type="button" onClick={() => remove(article.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
