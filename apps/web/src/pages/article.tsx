import type { ReactNode } from 'react';

/** A saved article as `GET /api/articles` returns it. */
export type Article = {
  id: string;
  title: string | null;
  siteName: string | null;
  sourceUrl: string | null;
  status: 'pending' | 'ready' | 'failed';
  wordCount: number | null;
  addedVia: 'email' | 'web' | 'gmail';
  createdAt: string;
};

/** An archived article as `GET /api/articles?archived=1` returns it. */
export type ArchivedArticle = Article & { archivedAt: string; archiveReason: 'printed' | 'skipped' | null };

const STATUS: Record<Article['status'], ReactNode> = {
  ready: null,
  pending: <span className="badge">Fetching</span>,
  failed: <span className="badge badge-failed">Failed</span>,
};

/** "Nov 20", plus the year when it isn't this year. */
export function shortDate(iso: string): string {
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' });
}

/** The details line under an article title: site, reading time, saved date and status. */
export function articleMeta(article: Article & { archiveReason?: ArchivedArticle['archiveReason'] }): ReactNode {
  const parts: ReactNode[] = [];
  if (article.siteName) parts.push(article.siteName);
  if (article.wordCount) parts.push(`${Math.max(1, Math.round(article.wordCount / 230))} min read`);
  parts.push(new Date(article.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
  if (STATUS[article.status]) parts.push(STATUS[article.status]);
  return (
    <>
      {/* First, so the narrow row's ellipsis never hides it. */}
      {article.addedVia === 'gmail' && <span className="tag">Gmail</span>}
      {article.archiveReason === 'skipped' && <span className="tag">Not printed</span>}
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 && ' · '}
          {part}
        </span>
      ))}
    </>
  );
}

/** The article's title, linking to its source when it has one. */
export function ArticleTitle({ article }: { article: Article }) {
  return article.sourceUrl ? (
    <a className="title" dir="auto" href={article.sourceUrl}>
      {article.title ?? article.sourceUrl}
    </a>
  ) : (
    <span className="title" dir="auto">
      {article.title ?? 'Untitled'}
    </span>
  );
}
