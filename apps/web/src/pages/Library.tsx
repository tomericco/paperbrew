import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { authClient } from '../auth';
import { Layout } from '../Layout';

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

  if (isPending || !session) return <Layout>{null}</Layout>;
  return <LibraryContent name={session.user.name} />;
}

function LibraryContent({ name }: { name: string }) {
  const [me, setMe] = useState<Me | null>(null);
  const [articles, setArticles] = useState<Article[] | null>(null);
  const [loadError, setLoadError] = useState('');

  const [copied, setCopied] = useState(false);

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
        setArticles(articlesBody.articles);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Could not load your library.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  async function copyAddress(address: string) {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked: select the address so Cmd/Ctrl+C copies it.
      const el = document.querySelector('.address');
      if (el) getSelection()?.selectAllChildren(el);
    }
  }

  const header = (
    <>
      {me && (
        <span className="row address-bar">
          <code className="address">{me.address}</code>
          <button type="button" onClick={() => copyAddress(me.address)}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </span>
      )}
      <span className="who">{name}</span>
      <button type="button" onClick={signOut}>
        Sign out
      </button>
    </>
  );

  let content: ReactNode;
  if (loadError) content = <p className="error">{loadError}</p>;
  else if (!me || !articles) content = <p className="muted">Loading…</p>;
  else
    content = (
      <div className="grid">
        <section className="span-12">
          <div className="page-head">
            <h1>Saved articles</h1>
            <button type="button" className="btn-primary" onClick={brew} disabled={brewing || articles.length === 0}>
              {brewing ? 'Brewing…' : 'Brew'}
            </button>
          </div>
          {brewError && (
            <p className="error" role="alert">
              {brewError}
            </p>
          )}
          {articles.length === 0 ? (
            <p className="empty muted">No articles yet. Forward an email with a link to the address above.</p>
          ) : (
            <ul className="list">
              {articles.map((article) => (
                <li key={article.id} className="list-item">
                  <div className="body">
                    {article.sourceUrl ? (
                      <a className="title" href={article.sourceUrl}>
                        {article.title ?? article.sourceUrl}
                      </a>
                    ) : (
                      <span className="title">{article.title ?? 'Untitled'}</span>
                    )}
                    <span className="meta">{articleMeta(article)}</span>
                  </div>
                  <button type="button" className="btn-quiet" onClick={() => remove(article.id)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    );

  return <Layout actions={header}>{content}</Layout>;
}

const STATUS: Record<Article['status'], ReactNode> = {
  ready: null,
  pending: <span className="badge">Fetching</span>,
  failed: <span className="badge badge-failed">Failed</span>,
};

function articleMeta(article: Article): ReactNode {
  const parts: ReactNode[] = [];
  if (article.siteName) parts.push(article.siteName);
  if (article.wordCount) parts.push(`${Math.max(1, Math.round(article.wordCount / 230))} min read`);
  parts.push(new Date(article.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
  if (STATUS[article.status]) parts.push(STATUS[article.status]);
  return parts.map((part, i) => (
    <span key={i}>
      {i > 0 && ' · '}
      {part}
    </span>
  ));
}
