import { useEffect, useRef, useState } from 'react';
import { errorText } from '../layouts';
import type { PaperLayout } from '../layouts';
import { LOOK_FONTS, PAPER_LOOKS, toPaperLook } from '../looks';
import type { PaperLook } from '../looks';
import { load } from './api';
import { Card } from './Card';
import { MagazinePreview } from './MagazinePreview';
import type { CardProps } from './steps';

type Me = { paperLayout: PaperLayout; paperLook: string };
type Choice = { paperLayout: PaperLayout; paperLook: PaperLook };

const DEFAULTS: Choice = { paperLayout: 'flat', paperLook: 'broadsheet' };

// What the preview holds: example titles, since the pile is not there yet.
const SAMPLE_TITLES = [
  'Why most dashboards go unread',
  'A field guide to quiet software',
  'What the compiler knows that you don’t',
  'The case for a four-day reading week',
];
const SAMPLE_MINUTES = 41;

const PAPER_NOTES: Record<PaperLayout, { label: string; note: string }> = {
  booklet: { label: 'Booklet', note: 'A5 pages folded from A4. Two-sided printer.' },
  flat: { label: 'Flat A4', note: 'Loose pages, one or two sided.' },
};

const PAPER_ORDER: PaperLayout[] = ['booklet', 'flat'];

function PaperIcon({ layout }: { layout: PaperLayout }) {
  return (
    <svg className="ob-paper-icon" viewBox="0 0 96 56" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      {layout === 'booklet' ? (
        <>
          <rect x="6" y="4" width="40" height="48" rx="1.5" />
          <rect x="50" y="4" width="40" height="48" rx="1.5" />
          <path d="M13 14h26M13 20h26M13 26h18M57 14h26M57 20h26M57 26h18" opacity=".5" />
        </>
      ) : (
        <>
          <rect x="28" y="4" width="40" height="48" rx="1.5" />
          <path d="M35 14h26M35 20h26M35 26h26M35 32h16" opacity=".5" />
        </>
      )}
    </svg>
  );
}

/** Paper and style, saved the moment they change and shown in a live preview. */
export function LookCard({ next, back }: CardProps) {
  const [choice, setChoice] = useState<Choice | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState('');
  // What the server last confirmed, per field: a failed save puts the field back to this.
  const confirmed = useRef<Choice>(DEFAULTS);
  // Saves go one after another, so two quick changes cannot reach the server out of order.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const latest = useRef<Choice>(DEFAULTS);

  useEffect(() => {
    let cancelled = false;
    load<Me>('/api/me').then((me) => {
      if (cancelled) return;
      if (!me) {
        setLoadFailed(true);
        return;
      }
      const loaded: Choice = { paperLayout: me.paperLayout === 'booklet' ? 'booklet' : 'flat', paperLook: toPaperLook(me.paperLook) };
      confirmed.current = loaded;
      latest.current = loaded;
      setChoice(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function save<K extends keyof Choice>(field: K, value: Choice[K]) {
    if (!choice || latest.current[field] === value) return;
    latest.current = { ...latest.current, [field]: value };
    setChoice((c) => (c ? { ...c, [field]: value } : c));
    setError('');
    queue.current = queue.current.then(async () => {
      let failure = '';
      try {
        const res = await fetch('/api/me/settings', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ [field]: value }),
        });
        if (res.status === 401) {
          location.replace('/signin');
          return;
        }
        if (res.ok) confirmed.current = { ...confirmed.current, [field]: value };
        else failure = await errorText(res, "Couldn't save that. Try again.");
      } catch {
        failure = "Couldn't save that. Try again.";
      }
      if (failure) {
        // Put the field back, unless a newer choice has replaced it already.
        if (latest.current[field] === value) {
          latest.current = { ...latest.current, [field]: confirmed.current[field] };
          setChoice((c) => (c ? { ...c, [field]: confirmed.current[field] } : c));
        }
        setError(failure);
      }
    });
  }

  const footer = (
    <>
      <button type="button" className="ob-link" onClick={back}>
        Back
      </button>
      <span className="ob-grow" />
      <button type="button" className="btn-primary" onClick={next}>
        Continue
      </button>
    </>
  );

  return (
    <Card step={2} footer={footer}>
      <h2>How should it look?</h2>
      <p className="ob-muted">You can change this any time, for every issue.</p>
      {loadFailed ? (
        <p className="ob-error" role="alert">
          Couldn't load your settings. You can set this later in Settings.
        </p>
      ) : !choice ? (
        <p className="ob-muted" role="status">
          Loading…
        </p>
      ) : (
        <>
          <div role="group" aria-labelledby="ob-paper-label">
            <div className="ob-eyebrow ob-group-label" id="ob-paper-label">
              Paper
            </div>
            <div className="ob-choices">
              {PAPER_ORDER.map((value) => (
                <button
                  key={value}
                  type="button"
                  className="ob-choice"
                  aria-pressed={choice.paperLayout === value}
                  onClick={() => save('paperLayout', value)}
                >
                  <PaperIcon layout={value} />
                  <b>{PAPER_NOTES[value].label}</b>
                  <span>{PAPER_NOTES[value].note}</span>
                </button>
              ))}
            </div>
          </div>
          <div role="group" aria-labelledby="ob-style-label">
            <div className="ob-eyebrow ob-group-label" id="ob-style-label">
              Style
            </div>
            <div className="ob-choices ob-choices-3">
              {PAPER_LOOKS.map((look) => (
                <button
                  key={look.value}
                  type="button"
                  className="ob-choice"
                  aria-pressed={choice.paperLook === look.value}
                  onClick={() => save('paperLook', look.value)}
                >
                  <span className="ob-aa" style={{ fontFamily: LOOK_FONTS[look.value].display }} aria-hidden="true">
                    Aa<i style={{ background: look.accent }} />
                  </span>
                  <b>{look.label}</b>
                  <span>{look.note}</span>
                </button>
              ))}
            </div>
          </div>
          <p className="ob-error" role="alert">
            {error}
          </p>
          <MagazinePreview
            look={choice.paperLook}
            layout={choice.paperLayout}
            titles={SAMPLE_TITLES}
            minutes={SAMPLE_MINUTES}
          />
          <p className="ob-muted ob-small">A preview with example articles.</p>
        </>
      )}
    </Card>
  );
}
