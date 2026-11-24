import { useId } from 'react';
import { ArticleTitle, articleMeta } from '../article';
import type { Article } from '../article';
import { AddressCopy } from '../onboarding/AddressCopy';

/** How the pile is shown: ticked by hand, picked by the schedule, or plain while the schedule is unknown. */
export type PileMode = 'hand' | 'scheduled' | 'unknown';

/**
 * The reading pile, oldest first. By hand: a checkbox per article (the title is its label), and a ticked
 * article past the 50 that fit in one issue is marked "Next time". On a schedule: "In issue" for the
 * articles the next issue would take (the server's pick), "Next time" for the rest. While the schedule is
 * loading or failed to load: just the articles, with Remove. Empty: the address.
 */
export function Pile({
  articles,
  mode,
  inIssue,
  budgetMinutes,
  unticked,
  going,
  address,
  gmailConnected,
  onToggle,
  onToggleAll,
  onRemove,
}: {
  articles: Article[];
  mode: PileMode;
  /** The next scheduled issue's ids; null while unknown. */
  inIssue: ReadonlySet<string> | null;
  budgetMinutes: number | null;
  unticked: ReadonlySet<string>;
  /** By hand: the ticked ids that fit in this issue. */
  going: ReadonlySet<string>;
  address: string;
  gmailConnected: boolean;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  onRemove: (article: Article) => void;
}) {
  const idBase = useId();
  const scheduled = mode === 'scheduled';
  const allTicked = unticked.size === 0 || articles.every((a) => !unticked.has(a.id));

  let hint = '';
  if (scheduled)
    hint = budgetMinutes
      ? `Picked oldest first to fill your ${budgetMinutes} minutes. Switch to by hand to choose yourself.`
      : 'Picked oldest first to fill your reading time. Switch to by hand to choose yourself.';
  else if (mode === 'hand') hint = 'Tick the articles for your next issue.';

  return (
    <section className="desk-card desk-pile" aria-labelledby={`${idBase}-title`}>
      <div className="desk-pile-head">
        <h2 id={`${idBase}-title`}>Reading pile</h2>
        <span className="desk-soft desk-small">{articles.length === 1 ? '1 saved' : `${articles.length} saved`}</span>
      </div>
      {articles.length === 0 ? (
        <div className="desk-empty">
          <h3>Nothing saved yet</h3>
          <p className="desk-soft">
            {gmailConnected ? 'Newsletters from Gmail land here as they arrive. ' : ''}
            Forward an email with a link to your private address and the article lands here.
          </p>
          <AddressCopy address={address} />
        </div>
      ) : (
        <>
          {hint && (
            <div className="desk-pile-bar">
              <p className="desk-soft desk-small">{hint}</p>
              {mode === 'hand' && (
                <button type="button" className="desk-link" onClick={onToggleAll}>
                  {allTicked ? 'Untick all' : 'Tick all'}
                </button>
              )}
            </div>
          )}
          <ul className="desk-rows">
            {articles.map((article) => {
              const titleId = `${idBase}-${article.id}`;
              const ticked = !unticked.has(article.id);
              const pastCap = mode === 'hand' && ticked && !going.has(article.id);
              return (
                <li key={article.id} className={`desk-row is-${mode}`}>
                  {scheduled && (
                    <span className={inIssue?.has(article.id) ? 'desk-pick is-in' : 'desk-pick'}>
                      {inIssue === null ? '…' : inIssue.has(article.id) ? 'In issue' : 'Next time'}
                    </span>
                  )}
                  {mode === 'hand' && (
                    <label className="desk-check">
                      <input type="checkbox" checked={ticked} aria-labelledby={titleId} onChange={() => onToggle(article.id)} />
                    </label>
                  )}
                  <div className="desk-row-body">
                    <span id={titleId} className="desk-row-title">
                      <ArticleTitle article={article} />
                    </span>
                    <span className="desk-row-meta">
                      {pastCap && <span className="desk-pick">Next time</span>}
                      {articleMeta(article)}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn-quiet desk-remove"
                    aria-describedby={titleId}
                    onClick={() => onRemove(article)}
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
