import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { authClient } from '../auth';
import { Layout } from '../Layout';
import type { Article } from './article';
import { BrewedDialog } from './BrewedDialog';
import { downloadBrew } from './brewClient';
import { AccountActions } from './desk/AccountActions';
import { formatWhen, MAX_BREW_IDS, minutesOf, plural, relativeDay, scheduleText } from './desk/format';
import { Pile } from './desk/Pile';
import type { PileMode } from './desk/Pile';
import { lookText, SetupRail } from './desk/SetupRail';
import type { Gmail, SetupMe } from './desk/SetupRail';
import { errorText } from './layouts';
import { load } from './onboarding/api';
import { AddressCopy } from './onboarding/AddressCopy';
import type { Device } from './usePairing';
import { useSchedule } from './useSchedule';
import type { Schedule, SchedulePatch } from './useSchedule';

type Me = SetupMe & { address: string; token: string; email: string | null; needsOnboarding: boolean };

/** `GET /api/me/next-issue`: what the next scheduled issue would hold, by the server's own pick rule. */
type NextIssue = { ids: string[]; minutes: number; budgetMinutes: number };

const LOAD_ERROR = 'Could not load your desk.';

/** Whether the schedule (and so the desk's mode) is known yet. Accounts without schedules are always 'ready'. */
type ScheduleState = 'loading' | 'failed' | 'ready';

/** The signed-in home (`/app`): the next issue on top, the reading pile, and the setup rail. */
export function Library() {
  const { data: session, isPending } = authClient.useSession();
  // The archive moved to Issues; an old link to the Archived tab still lands there.
  const archivedLink = new URLSearchParams(location.search).get('tab') === 'archived';

  useEffect(() => {
    if (archivedLink) location.replace('/app/issues');
    else if (!isPending && !session) location.replace('/signin');
  }, [archivedLink, isPending, session]);

  if (archivedLink || isPending || !session) return <Layout nav="desk">{null}</Layout>;
  return <Desk name={session.user.name} />;
}

function Desk({ name }: { name: string }) {
  const [me, setMe] = useState<Me | null>(null);
  const [articles, setArticles] = useState<Article[] | null>(null);
  const [loadError, setLoadError] = useState('');
  // undefined while loading, null when the request failed.
  const [gmail, setGmail] = useState<Gmail | null | undefined>(undefined);
  const [devices, setDevices] = useState<Device[] | null | undefined>(undefined);
  const [nextIssue, setNextIssue] = useState<NextIssue | null | undefined>(undefined);
  const nextIssueRun = useRef(0);
  const devicesRun = useRef(0);
  const {
    schedule,
    loadError: scheduleLoadError,
    saving: scheduleSaving,
    error: scheduleError,
    save: saveSchedule,
    reload: reloadSchedule,
  } = useSchedule();

  // By hand every article is ticked unless unticked here, so new arrivals start ticked.
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());

  const [brewing, setBrewing] = useState(false);
  const [brewError, setBrewError] = useState('');
  // The ids that went into the issue just downloaded; non-null while the success dialog is open.
  const [brewedIds, setBrewedIds] = useState<string[] | null>(null);
  const brewRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  /** Re-reads the next scheduled issue; the latest call wins. */
  const refreshNextIssue = useCallback(async () => {
    const run = ++nextIssueRun.current;
    const body = await load<NextIssue>('/api/me/next-issue');
    if (run === nextIssueRun.current) setNextIssue(body);
  }, []);

  /** (Re-)reads the paired Mac; the latest call wins. */
  const loadDevices = useCallback(async () => {
    const run = ++devicesRun.current;
    setDevices(undefined);
    const body = await load<{ devices: Device[] }>('/api/me/print-devices');
    if (run === devicesRun.current) setDevices(body ? body.devices : null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Both start now, but onboarding is decided on /api/me alone: a failing /api/articles must not hide the redirect.
    const articlesReq = fetch('/api/articles').catch(() => null);
    (async () => {
      try {
        const meRes = await fetch('/api/me');
        if (meRes.status === 401) {
          location.replace('/signin');
          return;
        }
        if (!meRes.ok) throw new Error();
        const meBody = (await meRes.json()) as Me;
        if (cancelled) return;
        // A brand-new account starts with the guided setup.
        if (meBody.needsOnboarding) {
          location.replace('/app/welcome');
          return;
        }
        setMe(meBody);
        const articlesRes = await articlesReq;
        if (articlesRes?.status === 401) {
          location.replace('/signin');
          return;
        }
        if (!articlesRes?.ok) throw new Error();
        const body = (await articlesRes.json()) as { articles: Article[] };
        if (!cancelled) setArticles(body.articles);
      } catch {
        if (!cancelled) setLoadError(LOAD_ERROR);
      }
    })();
    void load<Gmail>('/api/me/gmail').then((body) => {
      if (!cancelled) setGmail(body);
    });
    void loadDevices();
    void refreshNextIssue();
    return () => {
      cancelled = true;
    };
  }, [loadDevices, refreshNextIssue]);

  // Oldest first: the order the server picks in, for a scheduled issue and for a brew of everything.
  const pile = useMemo(
    () => (articles ? [...articles].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)) : []),
    [articles],
  );
  // Which mode the desk is in is only known once the schedule has loaded (when this account has one).
  const scheduleState: ScheduleState = !me?.scheduleAvailable ? 'ready' : scheduleLoadError ? 'failed' : schedule ? 'ready' : 'loading';
  const mode: PileMode = scheduleState !== 'ready' ? 'unknown' : me?.scheduleAvailable && schedule?.enabled ? 'scheduled' : 'hand';
  const inIssue = useMemo(() => (nextIssue ? new Set(nextIssue.ids) : null), [nextIssue]);

  // By hand: the ticked articles, of which the first 50 go in.
  const ticked = useMemo(() => pile.filter((a) => !unticked.has(a.id)), [pile, unticked]);
  const going = useMemo(() => ticked.slice(0, MAX_BREW_IDS), [ticked]);
  const goingIds = useMemo(() => new Set(going.map((a) => a.id)), [going]);

  function toggle(id: string) {
    setUnticked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setUnticked(ticked.length === pile.length ? new Set(pile.map((a) => a.id)) : new Set());
  }

  async function brew(ids: string[] | undefined) {
    setBrewing(true);
    setBrewError('');
    try {
      const result = await downloadBrew(ids);
      // Exactly what went into the PDF, which can be fewer than asked for if one was archived meanwhile.
      setBrewedIds(result.ids);
    } catch (err) {
      setBrewError(err instanceof Error ? err.message : 'Brewing failed.');
    } finally {
      setBrewing(false);
    }
  }

  function brewByHand() {
    // Everything ticked and within one issue: no ids, and the server brews the whole pile.
    const everything = ticked.length === pile.length && pile.length <= MAX_BREW_IDS;
    void brew(everything ? undefined : going.map((a) => a.id));
  }

  function brewNextIssue() {
    if (nextIssue && nextIssue.ids.length > 0) void brew(nextIssue.ids.slice(0, MAX_BREW_IDS));
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
    void refreshNextIssue();
  }

  function closeBrewed() {
    setBrewedIds(null);
    // Brew was disabled (so lost focus) while brewing; return to it, or to the card's heading if it is gone.
    if (brewRef.current && !brewRef.current.disabled) brewRef.current.focus();
    else titleRef.current?.focus();
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
      if (res.ok || res.status === 404) {
        setArticles((prev) => prev?.filter((a) => a.id !== article.id) ?? prev);
        void refreshNextIssue();
      }
    } catch {
      // leave the row; the user can retry
    }
  }

  async function toggleSchedule() {
    if (!schedule) return;
    const on = !schedule.enabled;
    const patch: SchedulePatch = { brewEnabled: on };
    // A schedule with no days never brews: turning it on picks Sunday so it is valid.
    if (on && schedule.days.length === 0) patch.brewDays = [0];
    await saveSchedule(patch);
  }

  let content: ReactNode;
  if (loadError) content = <p className="desk-error">{loadError}</p>;
  else if (!me || !articles) content = <p className="desk-soft">Loading…</p>;
  else
    content = (
      <div className="desk-page">
        {/* DOM order is the phone order (top card, switch, pile, setup), so focus follows the layout. */}
        <div className={me.scheduleAvailable ? 'desk-grid' : 'desk-grid no-brewing'}>
          <Hero
            me={me}
            mode={mode}
            scheduleState={scheduleState}
            schedule={schedule}
            nextIssue={nextIssue}
            devices={devices}
            pileSize={pile.length}
            ticked={ticked}
            going={going}
            brewing={brewing}
            brewError={brewError}
            brewRef={brewRef}
            titleRef={titleRef}
            onBrewByHand={brewByHand}
            onBrewNextIssue={brewNextIssue}
            onRetrySchedule={() => {
              // The button goes away with the state it belongs to; the card's heading keeps focus.
              titleRef.current?.focus();
              reloadSchedule();
            }}
            onRetryDevices={() => {
              titleRef.current?.focus();
              void loadDevices();
            }}
          />
          {me.scheduleAvailable && (
            <BrewingCard
              schedule={schedule}
              loadError={scheduleLoadError}
              saving={scheduleSaving}
              error={scheduleError}
              onToggle={() => void toggleSchedule()}
            />
          )}
          <Pile
            articles={pile}
            mode={mode}
            inIssue={inIssue}
            budgetMinutes={nextIssue?.budgetMinutes ?? schedule?.budgetMinutes ?? null}
            unticked={unticked}
            going={goingIds}
            address={me.address}
            gmailConnected={!!gmail?.connected}
            onToggle={toggle}
            onToggleAll={toggleAll}
            onRemove={(article) => void remove(article)}
          />
          <div className="desk-rail">
            <SetupRail me={me} gmail={gmail} schedule={schedule} scheduleFailed={!!scheduleLoadError} devices={devices} />
            {pile.length > 0 && (
              <section className="desk-card desk-save" aria-labelledby="desk-save-title">
                <h2 id="desk-save-title">Save an article</h2>
                <p className="desk-soft desk-small">Forward an email with a link to your private address.</p>
                <AddressCopy address={me.address} />
              </section>
            )}
          </div>
        </div>
        {brewedIds && (
          <BrewedDialog count={brewedIds.length} onArchive={() => archiveBrewed(brewedIds)} onClose={closeBrewed} />
        )}
      </div>
    );

  return (
    <Layout nav="desk" actions={<AccountActions name={name} />}>
      {content}
    </Layout>
  );
}

/** The switch between brewing on a schedule and by hand. Turning it on keeps the days, hour and reading time. */
function BrewingCard({
  schedule,
  loadError,
  saving,
  error,
  onToggle,
}: {
  schedule: Schedule | null;
  loadError: string;
  saving: boolean;
  error: string;
  onToggle: () => void;
}) {
  const on = !!schedule?.enabled;
  let summary = '';
  if (schedule)
    summary = on
      ? schedule.days.length > 0
        ? `${scheduleText(schedule.days, schedule.hour)}, about ${schedule.budgetMinutes} minutes of reading.`
        : 'Pick at least one day in Settings.'
      : 'You pick the articles and brew when you like.';

  return (
    <section className="desk-card desk-brewing" aria-labelledby="desk-brewing-title">
      <h2 id="desk-brewing-title">Brewing</h2>
      {loadError ? (
        <p className="desk-error">{loadError}</p>
      ) : !schedule ? (
        <p className="desk-soft desk-small">Loading…</p>
      ) : (
        <>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label="On a schedule"
            aria-describedby="desk-brewing-summary"
            aria-busy={saving}
            className="desk-switch"
            onClick={onToggle}
          >
            <span className={on ? 'desk-switch-side' : 'desk-switch-side is-current'} aria-hidden="true">
              By hand
            </span>
            <span className="desk-switch-track" aria-hidden="true" />
            <span className={on ? 'desk-switch-side is-current' : 'desk-switch-side'} aria-hidden="true">
              On a schedule
            </span>
          </button>
          <p id="desk-brewing-summary" className="desk-soft desk-small">
            {summary}
          </p>
        </>
      )}
      {error && (
        <p className="desk-error desk-small" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * The top card. Until the schedule has loaded it only says it is checking (a failed load says so, with Try
 * again), so a scheduled user never sees the by-hand card first. On a schedule with a Mac: when the next issue
 * prints and what it holds, with "Brew now instead". On a schedule without a Mac: paused, waiting for one; while
 * the Mac is unknown (loading or failed) it names the time but claims neither. By hand: the ticked articles and
 * Brew now.
 */
function Hero({
  me,
  mode,
  scheduleState,
  schedule,
  nextIssue,
  devices,
  pileSize,
  ticked,
  going,
  brewing,
  brewError,
  brewRef,
  titleRef,
  onBrewByHand,
  onBrewNextIssue,
  onRetrySchedule,
  onRetryDevices,
}: {
  me: Me;
  mode: PileMode;
  scheduleState: ScheduleState;
  schedule: Schedule | null;
  nextIssue: NextIssue | null | undefined;
  devices: Device[] | null | undefined;
  pileSize: number;
  ticked: Article[];
  going: Article[];
  brewing: boolean;
  brewError: string;
  brewRef: RefObject<HTMLButtonElement | null>;
  titleRef: RefObject<HTMLHeadingElement | null>;
  onBrewByHand: () => void;
  onBrewNextIssue: () => void;
  onRetrySchedule: () => void;
  onRetryDevices: () => void;
}) {
  const look = lookText(me);
  const lookLine = (
    <>
      {look} · <a href="/app/settings">Change<span className="visually-hidden"> the look</span></a>
    </>
  );

  let eyebrow: string;
  let title: string;
  let body: ReactNode = null;
  let action: ReactNode = null;
  let notice: ReactNode = null;
  let busy = false;
  const scheduled = mode === 'scheduled' && schedule !== null;

  if (scheduleState === 'loading') {
    busy = true;
    eyebrow = 'Your next issue';
    title = 'Checking your schedule…';
    body = (
      <div className="desk-skeleton" aria-hidden="true">
        <i />
        <i />
      </div>
    );
  } else if (scheduleState === 'failed') {
    eyebrow = 'Your next issue';
    title = "Couldn't check your schedule";
    body = <p className="desk-soft">Your saved articles are still below. Try again to see when your next issue brews.</p>;
    action = (
      <button type="button" className="desk-cta" onClick={onRetrySchedule}>
        Try again
      </button>
    );
  } else if (scheduled) {
    const rel = schedule.nextBrewAt ? relativeDay(schedule.nextBrewAt, schedule.timezone) : null;
    const when = schedule.nextBrewAt ? formatWhen(schedule.nextBrewAt, schedule.timezone) : null;
    // Only a successful device check may say "Paused" or "Prints …"; until then the card names the time only.
    const macKnown = devices !== undefined && devices !== null;
    if (macKnown && devices.length === 0) {
      eyebrow = 'Paused';
      title = 'Waiting for a Mac';
      notice = (
        <div className="desk-warn">
          <p>Scheduled issues only brew while a Mac is connected, so nothing will print yet.</p>
          {me.macAppUrl && (
            <a className="btn desk-cta" href="/app/settings">
              Connect a Mac
            </a>
          )}
        </div>
      );
    } else {
      if (schedule.brewDue) title = 'Within the hour';
      else title = when ?? 'Pick a day';
      if (!macKnown) eyebrow = 'Scheduled';
      else if (schedule.brewDue) eyebrow = 'Printing soon';
      else eyebrow = when && rel ? `Prints ${rel}` : 'Scheduled';
      if (devices === undefined) {
        busy = true;
        notice = <p className="desk-soft desk-small">Checking your Mac…</p>;
      } else if (devices === null)
        notice = (
          <div className="desk-warn">
            <p>Couldn't check your Mac. Scheduled issues only print while one is connected.</p>
            <button type="button" className="desk-cta" onClick={onRetryDevices}>
              Try again
            </button>
          </div>
        );
    }

    if (nextIssue === undefined) body = <p className="desk-soft">Checking what goes in…</p>;
    else if (nextIssue === null) body = <p className="desk-soft">Couldn't check what goes in the next issue.</p>;
    else if (nextIssue.ids.length === 0)
      body = (
        <p className="desk-soft">
          {pileSize === 0 ? 'Nothing in the pile yet. Anything you save before then goes in.' : 'Nothing ready for this issue yet.'}
        </p>
      );
    else {
      const pct = Math.min(100, Math.round((nextIssue.minutes / Math.max(1, nextIssue.budgetMinutes)) * 100));
      body = (
        <>
          <p className="desk-stats">
            <span>{plural(nextIssue.ids.length, 'article')}</span>
            <span>about {nextIssue.minutes} min of reading</span>
            <span>{lookLine}</span>
          </p>
          <div>
            <div className="desk-meter" aria-hidden="true">
              <i style={{ width: `${pct}%` }} />
            </div>
            <p className="desk-soft desk-small desk-meter-text">
              {nextIssue.minutes} of {nextIssue.budgetMinutes} minutes
            </p>
          </div>
        </>
      );
      action = (
        <button type="button" className="desk-cta" ref={brewRef} onClick={onBrewNextIssue} disabled={brewing}>
          {brewing ? 'Brewing…' : 'Brew now instead'}
        </button>
      );
    }
  } else {
    eyebrow = 'By hand';
    title = pileSize === 0 ? 'Your pile is empty' : 'Ready when you are';
    if (pileSize === 0) body = <p className="desk-soft">Save an article and it shows up in your pile, ready to brew.</p>;
    else {
      const minutes = going.reduce((sum, a) => sum + minutesOf(a), 0);
      const left = ticked.length - going.length;
      body = (
        <>
          <p className="desk-stats">
            <span>
              {going.length === pileSize ? plural(pileSize, 'article') : `${going.length} of ${plural(pileSize, 'article')}`}
            </span>
            {minutes > 0 && <span>about {minutes} min of reading</span>}
            <span>{lookLine}</span>
          </p>
          {left > 0 && (
            <p className="desk-note">
              One issue holds up to {MAX_BREW_IDS} articles. The oldest {MAX_BREW_IDS} you ticked go in;{' '}
              {plural(left, 'article is', 'articles are')} left out for the next one.
            </p>
          )}
        </>
      );
      action = (
        <button
          type="button"
          className="btn-primary desk-cta"
          ref={brewRef}
          onClick={onBrewByHand}
          disabled={brewing || going.length === 0}
        >
          {brewing ? 'Brewing…' : 'Brew now'}
        </button>
      );
    }
  }

  return (
    <section className="desk-card desk-hero" aria-labelledby="desk-hero-title" aria-busy={busy}>
      <p className="desk-eyebrow">{eyebrow}</p>
      <h1 id="desk-hero-title" ref={titleRef} tabIndex={-1}>
        {title}
      </h1>
      {body}
      {notice}
      {(action || scheduled) && (
        <div className="desk-actions">
          {action}
          {scheduled && (
            <a className="btn btn-quiet desk-cta" href="/app/settings">
              Edit schedule
            </a>
          )}
        </div>
      )}
      {brewError && (
        <p className="desk-error" role="alert">
          {brewError}
        </p>
      )}
    </section>
  );
}
