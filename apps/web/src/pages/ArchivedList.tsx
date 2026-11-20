import { useEffect, useState } from 'react';
import { ArticleTitle, articleMeta, shortDate } from './article';
import type { ArchivedArticle } from './article';

type Group = { archivedAt: string; articles: ArchivedArticle[] };

/** Rows come ordered by archive time, so each archive action is a run of rows with the same `archivedAt`. */
function groupByIssue(articles: ArchivedArticle[]): Group[] {
  const groups: Group[] = [];
  for (const article of articles) {
    const last = groups[groups.length - 1];
    if (last && last.archivedAt === article.archivedAt) last.articles.push(article);
    else groups.push({ archivedAt: article.archivedAt, articles: [article] });
  }
  return groups;
}

/** The Archived tab: past issues, newest first, each article with a "Move back" to Saved. */
export function ArchivedList({ onMovedBack }: { onMovedBack: (article: ArchivedArticle) => void }) {
  const [articles, setArticles] = useState<ArchivedArticle[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [moving, setMoving] = useState<ReadonlySet<string>>(new Set());
  const [moveError, setMoveError] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/articles?archived=1')
      .then(async (res) => {
        if (res.status === 401) {
          location.replace('/signin');
          return;
        }
        if (!res.ok) throw new Error();
        const body = (await res.json()) as { articles: ArchivedArticle[] };
        if (!cancelled) setArticles(body.articles);
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load your archive.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function moveBack(article: ArchivedArticle) {
    setMoveError('');
    setMoving((prev) => new Set(prev).add(article.id));
    try {
      const res = await fetch(`/api/articles/${encodeURIComponent(article.id)}/unarchive`, { method: 'POST' });
      // 404: it is no longer archived (saved again, or moved back elsewhere), so it is in Saved already.
      if (res.ok || res.status === 404) {
        setArticles((prev) => prev?.filter((a) => a.id !== article.id) ?? prev);
        onMovedBack(article);
      } else {
        setMoveError("Couldn't move it back. Try again.");
      }
    } catch {
      setMoveError("Couldn't move it back. Try again.");
    } finally {
      setMoving((prev) => {
        const next = new Set(prev);
        next.delete(article.id);
        return next;
      });
    }
  }

  if (loadError) return <p className="error">{loadError}</p>;
  if (!articles) return <p className="muted">Loading…</p>;
  if (articles.length === 0)
    return (
      <p className="empty muted">
        Nothing archived yet. After you brew an issue, archive it here to keep a record of what you read.
      </p>
    );

  return (
    <>
      {moveError && (
        <p className="error" role="alert">
          {moveError}
        </p>
      )}
      {groupByIssue(articles).map((group) => (
        <section key={group.archivedAt} className="issue">
          <h2 className="issue-head">
            Brewed {shortDate(group.archivedAt)} ·{' '}
            {group.articles.length === 1 ? '1 article' : `${group.articles.length} articles`}
          </h2>
          <ul className="list">
            {group.articles.map((article) => (
              <li key={article.id} className="list-item">
                <div className="body">
                  <ArticleTitle article={article} />
                  <span className="meta">{articleMeta(article)}</span>
                </div>
                <button
                  type="button"
                  className="btn-quiet"
                  disabled={moving.has(article.id)}
                  onClick={() => moveBack(article)}
                >
                  Move back
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
