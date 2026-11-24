import { useCallback, useEffect, useRef, useState } from 'react';
import type { Article } from '../article';
import { downloadBrew } from '../brewClient';
import type { PaperLayout } from '../layouts';
import { toPaperLook } from '../looks';
import { AddressCopy } from './AddressCopy';
import { load } from './api';
import { Card } from './Card';
import { MagazinePreview } from './MagazinePreview';
import type { CardProps } from './steps';

type Me = { address: string; paperLayout: PaperLayout; paperLook: string };
type Gmail =
  | { connected: false }
  | { connected: true; email: string; status: 'active' | 'needs_reconnect'; starter: { state: 'pending' | 'done'; saved: number } };

/** What the card is showing. */
type Phase = 'loading' | 'failed' | 'looking' | 'pollFailed' | 'found' | 'none';
type Brew = { state: 'idle' } | { state: 'brewing' } | { state: 'ready'; ids: string[]; downloading: boolean };

const POLL_EVERY_MS = 2000;
const POLL_GIVE_UP_MS = 60_000;
// A request that hangs must not keep the spinner up: past this it counts as a failed check.
const REQUEST_TIMEOUT_MS = 10_000;
const SHOWN = 3;

const minutesOf = (a: Article) => a.readingMinutes ?? (a.wordCount ? Math.max(1, Math.round(a.wordCount / 230)) : null);

/** Gmail connected and the starter fetch still running: the only time the card polls. */
const isLooking = (gmail: Gmail) => gmail.connected && gmail.status === 'active' && gmail.starter.state === 'pending';

/**
 * Aha 1: the first magazine. With Gmail connected the server fetches a few newsletters, which this card polls for
 * (every 2 s, never overlapping, at most 60 s). Found articles are brewed into a PDF; none found, or no Gmail,
 * shows the forwarding address and Check again.
 */
export function FirstIssueCard({ next, back }: CardProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [late, setLate] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkedEmpty, setCheckedEmpty] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [articles, setArticles] = useState<Article[]>([]);
  const [brew, setBrew] = useState<Brew>({ state: 'idle' });
  const [brewError, setBrewError] = useState('');

  const mounted = useRef(true);
  // Aborting this stops the run in progress: its request, and (via `stop`) the next scheduled poll.
  const run = useRef<AbortController | null>(null);
  const timer = useRef(0);

  const stop = useCallback(() => {
    run.current?.abort();
    run.current = null;
    clearTimeout(timer.current);
  }, []);

  /** Reads the pile and shows it: the first three ready articles, or the nothing-found state. */
  const showArticles = useCallback(async (signal: AbortSignal, timedOut: boolean) => {
    const res = await load<{ articles: Article[] }>('/api/articles', signal);
    if (signal.aborted) return;
    if (!res) {
      setPhase('failed');
      return;
    }
    const ready = res.articles.filter((a) => a.status === 'ready').slice(0, SHOWN);
    setArticles(ready);
    setLate(timedOut);
    setPhase(ready.length > 0 ? 'found' : 'none');
  }, []);

  /** Polls /me/gmail until the starter fetch is done. A tick starts only after the last one answered. */
  const poll = useCallback(
    (signal: AbortSignal) => {
      const deadline = Date.now() + POLL_GIVE_UP_MS;
      setPhase('looking');
      const tick = async () => {
        if (signal.aborted) return;
        const req = new AbortController();
        const onAbort = () => req.abort();
        signal.addEventListener('abort', onAbort, { once: true });
        const giveUpOnRequest = setTimeout(() => req.abort(), REQUEST_TIMEOUT_MS);
        const gmail = await load<Gmail>('/api/me/gmail', req.signal);
        clearTimeout(giveUpOnRequest);
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) return;
        if (!gmail) {
          setPhase('pollFailed');
          return;
        }
        if (!isLooking(gmail)) {
          await showArticles(signal, false);
          return;
        }
        if (Date.now() >= deadline) {
          await showArticles(signal, true);
          return;
        }
        timer.current = window.setTimeout(() => void tick(), POLL_EVERY_MS);
      };
      timer.current = window.setTimeout(() => void tick(), POLL_EVERY_MS);
    },
    [showArticles],
  );

  /** Decides what to show: poll if the starter fetch is running, else read the pile. */
  const begin = useCallback(
    async (kind: 'first' | 'check') => {
      stop();
      const controller = new AbortController();
      run.current = controller;
      const { signal } = controller;
      if (kind === 'first') setPhase('loading');
      else setChecking(true);
      const [meRes, gmail] = await Promise.all([load<Me>('/api/me', signal), load<Gmail>('/api/me/gmail', signal)]);
      if (signal.aborted) return;
      setChecking(false);
      if (!meRes || !gmail) {
        setPhase(meRes ? 'pollFailed' : 'failed');
        return;
      }
      setMe(meRes);
      if (isLooking(gmail)) {
        setCheckedEmpty(false);
        poll(signal);
        return;
      }
      await showArticles(signal, false);
      if (kind === 'check' && !signal.aborted) setCheckedEmpty(true);
    },
    [stop, poll, showArticles],
  );

  useEffect(() => {
    mounted.current = true;
    void begin('first');
    return () => {
      mounted.current = false;
      stop();
    };
  }, [begin, stop]);

  // After "Check again" finds something the empty-state note no longer applies.
  useEffect(() => {
    if (phase !== 'none') setCheckedEmpty(false);
  }, [phase]);

  // A new view takes focus on its heading, like a new card does, so a keyboard or screen reader user is not left behind.
  const view = `${phase}:${brew.state}`;
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    const heading = document.querySelector<HTMLElement>('.ob-card :is(h1, h2)');
    heading?.setAttribute('tabindex', '-1');
    heading?.focus();
  }, [view]);

  async function brewThese() {
    setBrew({ state: 'brewing' });
    setBrewError('');
    try {
      const { ids } = await downloadBrew(articles.map((a) => a.id));
      if (!mounted.current) return;
      if (ids.length === 0) {
        setBrew({ state: 'idle' });
        setBrewError('Those articles are no longer there. Check again.');
        return;
      }
      setBrew({ state: 'ready', ids, downloading: false });
    } catch (err) {
      if (!mounted.current) return;
      setBrew({ state: 'idle' });
      setBrewError(err instanceof Error ? err.message : 'Brewing failed.');
    }
  }

  async function downloadAgain(ids: string[]) {
    setBrewError('');
    setBrew({ state: 'ready', ids, downloading: true });
    try {
      await downloadBrew(ids);
    } catch (err) {
      if (mounted.current) setBrewError(err instanceof Error ? err.message : 'Brewing failed.');
    }
    if (mounted.current) setBrew({ state: 'ready', ids, downloading: false });
  }

  const backButton = (
    <button type="button" className="ob-link" onClick={back}>
      Back
    </button>
  );
  const skipButton = (
    <button type="button" onClick={next}>
      Skip for now
    </button>
  );

  let body;
  let footer;
  if (phase === 'loading') {
    body = (
      <>
        <h2>Brew your first issue</h2>
        <p className="ob-muted" role="status">
          Loading…
        </p>
      </>
    );
    footer = (
      <>
        {backButton}
        <span className="ob-grow" />
        {skipButton}
      </>
    );
  } else if (phase === 'failed' || phase === 'pollFailed') {
    body = (
      <>
        <h2>Brew your first issue</h2>
        <p className="ob-error" role="alert">
          {phase === 'pollFailed' ? "Couldn't check your inbox." : "Couldn't load your first issue."}
        </p>
        <div>
          <button type="button" onClick={() => void begin('first')}>
            Try again
          </button>
        </div>
      </>
    );
    footer = (
      <>
        {backButton}
        <span className="ob-grow" />
        {skipButton}
      </>
    );
  } else if (phase === 'looking') {
    body = (
      <>
        <h2>Looking in your inbox…</h2>
        <div className="ob-looking">
          <span className="ob-spin" aria-hidden="true" />
          <p className="ob-muted" role="status">
            Finding a few recent newsletters to start your pile. This takes a few seconds.
          </p>
        </div>
      </>
    );
    footer = (
      <>
        {backButton}
        <span className="ob-grow" />
        {skipButton}
      </>
    );
  } else if (phase === 'found' && brew.state === 'ready') {
    const brewed = brew.ids.map((id) => articles.find((a) => a.id === id)).filter((a): a is Article => a !== undefined);
    const minutes = brewed.reduce((sum, a) => sum + (minutesOf(a) ?? 5), 0);
    body = (
      <>
        <div>
          <div className="ob-eyebrow">First issue</div>
          <h2>Your magazine is ready</h2>
        </div>
        <p className="ob-muted">The PDF is in your downloads. Print it, or carry on and let Paperbrew do it for you.</p>
        {me && (
          <MagazinePreview
            look={toPaperLook(me.paperLook)}
            layout={me.paperLayout === 'booklet' ? 'booklet' : 'flat'}
            titles={brewed.map((a) => a.title ?? 'Untitled')}
            minutes={minutes}
          />
        )}
        {brewError && (
          <p className="ob-error" role="alert">
            {brewError}
          </p>
        )}
      </>
    );
    footer = (
      <>
        {backButton}
        <span className="ob-grow" />
        <span className="ob-actions">
          <button type="button" disabled={brew.downloading} onClick={() => void downloadAgain(brew.ids)}>
            {brew.downloading ? 'Downloading…' : 'Download again'}
          </button>
          <button type="button" className="btn-primary" onClick={next}>
            Continue
          </button>
        </span>
      </>
    );
  } else if (phase === 'found') {
    const brewing = brew.state === 'brewing';
    body = (
      <>
        <h2>Brew your first issue</h2>
        <p className="ob-muted">Here is what Paperbrew found for you. Brew it into a magazine you can print.</p>
        <ul className="ob-list ob-found">
          {articles.map((a) => {
            const minutes = minutesOf(a);
            return (
              <li key={a.id}>
                <div>
                  <b>{a.title ?? 'Untitled'}</b>
                  <span className="ob-muted ob-small">
                    {[a.siteName, minutes ? `${minutes} min` : null].filter(Boolean).join(' · ')}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
        {brewing && (
          <div className="ob-progress-wrap">
            <div className="ob-progress" role="progressbar" aria-label="Brewing your magazine" />
            <p className="ob-muted ob-small" role="status">
              Brewing your magazine. This can take up to half a minute.
            </p>
          </div>
        )}
        {brewError && (
          <p className="ob-error" role="alert">
            {brewError}
          </p>
        )}
      </>
    );
    footer = (
      <>
        {backButton}
        <span className="ob-grow" />
        <span className="ob-actions">
          {skipButton}
          <button type="button" className="btn-primary" disabled={brewing} onClick={() => void brewThese()}>
            {brewing ? 'Brewing…' : 'Brew these'}
          </button>
        </span>
      </>
    );
  } else {
    body = (
      <>
        <h2>Nothing to brew yet</h2>
        <p className="ob-muted">
          {late
            ? "We're still looking through your inbox, which can take a minute. You can also forward an email with a link to your private address and it lands in your pile."
            : 'Forward an email with a link, or a newsletter, to your private address and it lands in your pile.'}
        </p>
        {me && <AddressCopy address={me.address} />}
        <p className="ob-muted ob-small" role="status">
          {checkedEmpty ? 'Still nothing. Forward an email, then check again.' : ''}
        </p>
      </>
    );
    footer = (
      <>
        {backButton}
        <span className="ob-grow" />
        <span className="ob-actions">
          <button type="button" disabled={checking} onClick={() => void begin('check')}>
            {checking ? 'Checking…' : 'Check again'}
          </button>
          <button type="button" className="btn-primary" onClick={next}>
            Skip for now
          </button>
        </span>
      </>
    );
  }

  return (
    <Card step={3} footer={footer}>
      {body}
    </Card>
  );
}
