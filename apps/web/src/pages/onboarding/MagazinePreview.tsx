import type { CSSProperties } from 'react';
import type { PaperLayout } from '../layouts';
import { LOOK_FONTS, lookInfo } from '../looks';
import type { PaperLook } from '../looks';

const SAMPLE_TEXT =
  'A dashboard is a promise that someone will look. Most teams keep the promise for a week, then the tab joins forty others. The ones that last are built around a single decision, not a single screen.';

const SHORT_LAYOUT: Record<PaperLayout, string> = { flat: 'flat A4', booklet: 'booklet' };

/**
 * A small cover and inside page(s) of the magazine in a look: a booklet shows a two-page spread, flat A4 a single page.
 * Decorative (the pages are paper, so they keep paper colours); the label says what it shows.
 */
export function MagazinePreview({
  look,
  layout,
  titles,
  minutes,
}: {
  look: PaperLook;
  layout: PaperLayout;
  titles: string[];
  minutes: number;
}) {
  const info = lookInfo(look);
  const fonts = LOOK_FONTS[look];
  const style = { '--ob-d': fonts.display, '--ob-b': fonts.body, '--ob-a': info.accent } as CSSProperties;
  const date = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).toUpperCase();
  const first = titles[0] ?? 'Why most dashboards go unread';

  return (
    <div className="ob-mag" data-look={look} style={style} role="img" aria-label={`Preview of your magazine: ${info.label}, ${SHORT_LAYOUT[layout]}`}>
      <div className="ob-page ob-cover">
        <div>
          <div className="ob-bar" />
          <div className="ob-meta">Issue No. 1 · {date}</div>
        </div>
        <div className="ob-cover-title">Your reading, on paper</div>
        <ul>
          {titles.slice(0, 4).map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
        <div className="ob-meta">
          {titles.length} articles · {minutes} min
        </div>
      </div>
      <div className={layout === 'booklet' ? 'ob-spread' : 'ob-spread is-single'}>
        <div className="ob-page">
          <div className="ob-kick">Essay</div>
          <h4>{first}</h4>
          <p className="ob-tx">{SAMPLE_TEXT}</p>
          <p className="ob-tx">{SAMPLE_TEXT}</p>
        </div>
        {layout === 'booklet' && (
          <div className="ob-page">
            <div className="ob-quote">Built around a single decision, not a single screen.</div>
            <p className="ob-tx">{SAMPLE_TEXT}</p>
            <p className="ob-tx">{SAMPLE_TEXT}</p>
          </div>
        )}
      </div>
    </div>
  );
}
