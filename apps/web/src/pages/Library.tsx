import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { authClient } from '../auth';
import { Layout } from '../Layout';
import { ArchivedList } from './ArchivedList';
import { ArticleTitle, articleMeta } from './article';
import type { Article } from './article';
import { BrewedDialog } from './BrewedDialog';
import { errorText, LAYOUTS } from './layouts';
import type { PaperLayout } from './layouts';

type Me = { address: string; token: string; email: string | null; paperLayout: PaperLayout; needsOnboarding: boolean };

type Tab = 'saved' | 'archived';

const TABS: { value: Tab; label: string; heading: string }[] = [
  { value: 'saved', label: 'Saved', heading: 'Saved articles' },
  { value: 'archived', label: 'Archived', heading: 'Archived articles' },
];

function tabFromUrl(): Tab {
  return new URLSearchParams(location.search).get('tab') === 'archived' ? 'archived' : 'saved';
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
  // The ids that went into the issue just downloaded; non-null while the success dialog is open.
  const [brewedIds, setBrewedIds] = useState<string[] | null>(null);
  const brewRef = useRef<HTMLButtonElement>(null);

  const [tab, setTab] = useState<Tab>(tabFromUrl);
  const tabsId = useId();
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

  const [menuOpen, setMenuOpen] = useState(false);
  const splitRef = useRef<HTMLSpanElement>(null);
  const caretRef = useRef<HTMLButtonElement>(null);
  // Saves run one after another. `saveRef` is the latest one still in flight (resolves true if stored; null once settled);
  // `savedLayoutRef` is the last layout the server confirmed, which a failed save reverts to.
  const saveRef = useRef<Promise<boolean> | null>(null);
  const savedLayoutRef = useRef<PaperLayout>('flat');
  const saveCountRef = useRef(0);

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
        // A brand-new account starts with the guided setup.
        if (meBody.needsOnboarding) {
          location.replace('/app/welcome');
          return;
        }
        savedLayoutRef.current = meBody.paperLayout;
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

  // While the menu is open: Escape closes it (focus back on the caret), a press outside closes it,
  // and focus starts on the checked item.
  useEffect(() => {
    if (!menuOpen) return;
    splitRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      setMenuOpen(false);
      caretRef.current?.focus();
    }
    function onPointerDown(e: PointerEvent) {
      if (!splitRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [menuOpen]);

  function onMenuKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Tab') {
      // Close and put focus on the caret; the browser then moves on from there.
      setMenuOpen(false);
      caretRef.current?.focus();
      return;
    }
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]'));
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[(at + step + items.length) % items.length]?.focus();
  }

  function chooseLayout(next: PaperLayout) {
    setMenuOpen(false);
    caretRef.current?.focus();
    if (!me || next === me.paperLayout) return;
    setBrewError('');
    setMe({ ...me, paperLayout: next });
    const after = saveRef.current;
    const id = ++saveCountRef.current;
    const save: Promise<boolean> = (async () => {
      await after;
      let failure = '';
      try {
        const res = await fetch('/api/me/settings', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ paperLayout: next }),
        });
        if (res.ok) {
          savedLayoutRef.current = next;
          return true;
        }
        failure = await errorText(res, 'Could not save your paper layout.');
      } catch {
        failure = 'Could not save your paper layout.';
      }
      // A later pick supersedes this one, so only the latest save reverts and reports.
      if (saveCountRef.current === id) {
        setMe((prev) => (prev ? { ...prev, paperLayout: savedLayoutRef.current } : prev));
        setBrewError(failure);
      }
      return false;
    })();
    saveRef.current = save;
    // Once it settles it is no longer in flight, so Brew stops waiting for it.
    void save.then(() => {
      if (saveCountRef.current === id) saveRef.current = null;
    });
  }

  async function brew() {
    setBrewing(true);
    setMenuOpen(false);
    setBrewError('');
    try {
      // The server brews with the saved layout, so let a pending save land first.
      // Wait until no save is in flight (a newer pick may replace the one we awaited). If the last
      // save failed, its error stays visible and nothing is downloaded.
      let pending = saveRef.current;
      let saved = true;
      while (pending) {
        saved = await pending;
        const latest = saveRef.current;
        if (latest === pending) break;
        pending = latest;
      }
      if (!saved) return;
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
      // Exactly what is in this PDF, so archiving never touches an article that arrived mid-brew.
      setBrewedIds((res.headers.get('x-brew-article-ids') ?? '').split(',').filter(Boolean));
    } catch {
      setBrewError('Brewing failed.');
    } finally {
      setBrewing(false);
    }
  }

  async function archiveBrewed(ids: string[]) {
    const res = await fetch('/api/articles/archive', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) throw new Error(await errorText(res, 'Could not archive.'));
    const archived = new Set(ids);
    setArticles((prev) => prev?.filter((a) => !archived.has(a.id)) ?? prev);
  }

  function closeBrewed() {
    setBrewedIds(null);
    // Brew was disabled (so lost focus) while brewing; return to it, or to the tab if the queue is now empty.
    if (brewRef.current && !brewRef.current.disabled) brewRef.current.focus();
    else tabRefs.current.saved?.focus();
  }

  function selectTab(next: Tab, focus = false) {
    setTab(next);
    setMenuOpen(false);
    const url = new URL(location.href);
    if (next === 'archived') url.searchParams.set('tab', 'archived');
    else url.searchParams.delete('tab');
    history.replaceState(history.state, '', url);
    if (focus) tabRefs.current[next]?.focus();
  }

  function onTabsKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // Arrow keys move between tabs (one tab stop for the whole list).
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const at = TABS.findIndex((t) => t.value === tab);
    selectTab(TABS[(at + step + TABS.length) % TABS.length].value, true);
  }

  async function reloadSaved() {
    try {
      const res = await fetch('/api/articles');
      if (!res.ok) return;
      const body = (await res.json()) as { articles: Article[] };
      setArticles(body.articles);
    } catch {
      // The Saved list catches up on the next load.
    }
  }

  async function signOut() {
    await authClient.signOut();
    location.assign('/');
  }

  async function remove(article: Article) {
    // A Gmail article can also stop its sender: the server then skips that address from now on.
    let query = '';
    if (article.addedVia === 'gmail') {
      const who = article.siteName ?? 'this sender';
      if (confirm(`Also skip future emails from ${who}?`)) query = '?blockSender=1';
    }
    try {
      const res = await fetch(`/api/articles/${encodeURIComponent(article.id)}${query}`, { method: 'DELETE' });
      if (res.ok || res.status === 404) setArticles((prev) => prev?.filter((a) => a.id !== article.id) ?? prev);
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
      <a className="btn" href="/app/settings">
        Settings
      </a>
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
            <h1>{TABS.find((t) => t.value === tab)?.heading}</h1>
            {tab === 'saved' && (
              <span className="split" ref={splitRef}>
                <button
                  type="button"
                  className="btn-primary split-main"
                  ref={brewRef}
                  onClick={brew}
                  disabled={brewing || articles.length === 0}
                >
                  {brewing ? 'Brewing…' : 'Brew'}
                </button>
                <button
                  type="button"
                  className="btn-primary split-caret"
                  ref={caretRef}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  aria-label="Paper layout"
                  disabled={brewing}
                  onClick={() => setMenuOpen((open) => !open)}
                >
                  <svg width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
                    <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                </button>
                {menuOpen && (
                  <div className="menu" role="menu" aria-label="Paper layout" onKeyDown={onMenuKeyDown}>
                    {LAYOUTS.map((layout) => (
                      <button
                        key={layout.value}
                        type="button"
                        role="menuitemradio"
                        aria-checked={me.paperLayout === layout.value}
                        className="menu-item"
                        onClick={() => chooseLayout(layout.value)}
                      >
                        <span className="menu-label">{layout.label}</span>
                        <span className="menu-hint">{layout.hint}</span>
                      </button>
                    ))}
                  </div>
                )}
              </span>
            )}
          </div>
          <div className="tabs" role="tablist" aria-label="Articles" onKeyDown={onTabsKeyDown}>
            {TABS.map((t) => (
              <button
                key={t.value}
                type="button"
                role="tab"
                className="tab"
                id={`${tabsId}-${t.value}-tab`}
                aria-selected={tab === t.value}
                aria-controls={`${tabsId}-panel`}
                tabIndex={tab === t.value ? 0 : -1}
                ref={(el) => {
                  tabRefs.current[t.value] = el;
                }}
                onClick={() => selectTab(t.value)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${tab}-tab`}>
            {tab === 'saved' ? (
              <>
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
                          <ArticleTitle article={article} />
                          <span className="meta">{articleMeta(article)}</span>
                        </div>
                        <button type="button" className="btn-quiet" onClick={() => void remove(article)}>
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <ArchivedList onMovedBack={() => void reloadSaved()} />
            )}
          </div>
        </section>
        {brewedIds && (
          <BrewedDialog count={brewedIds.length} onArchive={() => archiveBrewed(brewedIds)} onClose={closeBrewed} />
        )}
      </div>
    );

  return <Layout actions={header}>{content}</Layout>;
}
