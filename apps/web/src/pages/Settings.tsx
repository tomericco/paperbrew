import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { authClient } from '../auth';
import { Layout } from '../Layout';
import { errorText, LAYOUTS } from './layouts';
import type { PaperLayout } from './layouts';
import { LOOK_FONTS, PAPER_LOOKS, toPaperLook } from './looks';
import type { PaperLook } from './looks';
import { GmailSection } from './settings/GmailSection';
import { PrinterSection } from './settings/PrinterSection';
import { ScheduleSection } from './settings/ScheduleSection';
import { SettingsCard, useReportStatus } from './settings/SettingsCard';
import type { SectionStatus } from './settings/SettingsCard';

type Me = { paperLayout: PaperLayout; paperLook: string; gmailAvailable: boolean; scheduleAvailable: boolean; macAppUrl: string | null };

const NOTICES: Record<string, string> = {
  connected: 'Gmail connected. New newsletters will appear within the hour.',
  error: "Couldn't connect Gmail. Try again.",
};

type SectionKey = 'gmail' | 'schedule' | 'printer' | 'paper';

/** The sections in the product's flow order. The first three are the setup steps; Paper is not. */
const SECTIONS: { key: SectionKey; id: string; label: string; todo?: string }[] = [
  { key: 'gmail', id: 'newsletters', label: 'Newsletters', todo: 'Connect Gmail' },
  { key: 'schedule', id: 'schedule', label: 'Schedule', todo: 'Pick your days' },
  { key: 'printer', id: 'printer', label: 'Printer', todo: 'Pair your Mac' },
  { key: 'paper', id: 'paper', label: 'Paper' },
];

type Section = (typeof SECTIONS)[number] & { step?: number };

const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function Settings() {
  const { data: session, isPending } = authClient.useSession();

  useEffect(() => {
    if (!isPending && !session) location.replace('/signin');
  }, [isPending, session]);

  if (isPending || !session) return <Layout>{null}</Layout>;
  return <SettingsContent name={session.user.name} />;
}

function SettingsContent({ name }: { name: string }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [statuses, setStatuses] = useState<Partial<Record<SectionKey, SectionStatus>>>({});

  useEffect(() => {
    let cancelled = false;
    fetch('/api/me')
      .then(async (res) => {
        if (res.status === 401) {
          location.replace('/signin');
          return;
        }
        if (!res.ok) throw new Error('Could not load your settings.');
        const body = (await res.json()) as Me;
        if (!cancelled) setMe(body);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Could not load your settings.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The Google round trip comes back as ?gmail=connected|error: say so once, then clean the URL.
  useEffect(() => {
    const url = new URL(location.href);
    const outcome = url.searchParams.get('gmail');
    if (outcome === null) return;
    if (Object.hasOwn(NOTICES, outcome)) setNotice(NOTICES[outcome]);
    url.searchParams.delete('gmail');
    history.replaceState(history.state, '', url);
  }, []);

  // One stable callback per section, so a section's report effect runs only when its status changes.
  const report = useMemo(() => {
    const make = (key: SectionKey) => (s: SectionStatus) =>
      setStatuses((prev) => {
        const old = prev[key];
        if (old && old.state === s.state && old.tone === s.tone && old.label === s.label) return prev;
        return { ...prev, [key]: s };
      });
    return { gmail: make('gmail'), schedule: make('schedule'), printer: make('printer'), paper: make('paper') };
  }, []);

  // Only the sections this account has; the setup steps are numbered when there are at least two.
  const sections: Section[] = useMemo(() => {
    if (!me) return [];
    const present = SECTIONS.filter(
      (s) =>
        s.key === 'paper' ||
        (s.key === 'gmail' && me.gmailAvailable) ||
        (s.key === 'schedule' && me.scheduleAvailable) ||
        (s.key === 'printer' && me.macAppUrl !== null),
    );
    const stepCount = present.filter((s) => s.todo).length;
    let n = 0;
    return present.map((s) => (s.todo && stepCount >= 2 ? { ...s, step: ++n } : s));
  }, [me]);

  const steps = sections.filter((s) => s.step !== undefined);
  const ids = useMemo(() => sections.map((s) => s.id), [sections]);
  const [active, activate] = useActiveSection(ids);

  const jump = useCallback(
    (id: string, e: MouseEvent<HTMLAnchorElement>) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = document.getElementById(id);
      if (!target) return;
      e.preventDefault();
      activate(id);
      target.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
      target.focus({ preventScroll: true });
      history.replaceState(history.state, '', `#${id}`);
    },
    [activate],
  );

  async function signOut() {
    await authClient.signOut();
    location.assign('/');
  }

  const header = (
    <>
      <a className="btn" href="/app">
        Library
      </a>
      <span className="who">{name}</span>
      <button type="button" onClick={signOut}>
        Sign out
      </button>
    </>
  );

  const progress = steps.length >= 2 ? <Progress steps={steps} statuses={statuses} /> : null;

  return (
    <Layout actions={header}>
      <div className="grid">
        <div className="span-12 settings">
          <header className="settings-head" style={{ '--i': 0 } as CSSProperties}>
            <h1>Settings</h1>
            <p className="settings-lede">Set it up once, and your reading turns up on paper.</p>
            {/* Always present, so a notice added later is announced. */}
            <div role="status" className="settings-status">
              {notice && <p className="notice">{notice}</p>}
            </div>
          </header>
          {loadError ? (
            <p className="error">{loadError}</p>
          ) : !me ? (
            <SettingsSkeleton />
          ) : (
            <>
              <SectionChips sections={sections} active={active} onJump={jump} />
              <div className="settings-body">
                <SidePanel sections={sections} statuses={statuses} active={active} progress={progress} onJump={jump} />
                <div className="settings-main">
                  {steps.length >= 2 && <SetupStrip steps={steps} statuses={statuses} progress={progress} onJump={jump} />}
                  {me.gmailAvailable && <GmailSection step={stepOf(sections, 'gmail')} onStatus={report.gmail} />}
                  {me.scheduleAvailable && <ScheduleSection step={stepOf(sections, 'schedule')} onStatus={report.schedule} />}
                  {me.macAppUrl && <PrinterSection macAppUrl={me.macAppUrl} step={stepOf(sections, 'printer')} onStatus={report.printer} />}
                  <PaperSection initial={me.paperLayout} initialLook={toPaperLook(me.paperLook)} onStatus={report.paper} />
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </Layout>
  );
}

function stepOf(sections: Section[], key: SectionKey): number | undefined {
  return sections.find((s) => s.key === key)?.step;
}

/**
 * The section in view, for the side panel and the chips: the one crossing a line a quarter of the way
 * down the screen, or the last one once the page is scrolled to the bottom. Without IntersectionObserver
 * nothing is highlighted and the links still work.
 */
function useActiveSection(ids: string[]): [string | null, (id: string) => void] {
  const [active, setActive] = useState<string | null>(null);
  // A click picks its section right away; the smooth scroll that follows must not flicker through the others.
  const heldUntil = useRef(0);
  const key = ids.join('|');

  useEffect(() => {
    if (!('IntersectionObserver' in window) || ids.length === 0) return;
    const elements = ids.map((id) => document.getElementById(id)).filter((el): el is HTMLElement => el !== null);
    const crossing = new Set<string>();
    const atBottom = () => innerHeight + scrollY >= document.documentElement.scrollHeight - 4;
    const pick = () => {
      if (Date.now() < heldUntil.current) return;
      if (atBottom()) setActive(ids[ids.length - 1]);
      else {
        const first = ids.find((id) => crossing.has(id));
        if (first) setActive(first);
        else if (scrollY < 40) setActive(ids[0]);
      }
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) crossing.add(entry.target.id);
          else crossing.delete(entry.target.id);
        }
        pick();
      },
      { rootMargin: '-25% 0px -74% 0px' },
    );
    elements.forEach((el) => observer.observe(el));
    addEventListener('scroll', pick, { passive: true });
    pick();
    return () => {
      observer.disconnect();
      removeEventListener('scroll', pick);
    };
    // `key` stands in for `ids`.
  }, [key]);

  const activate = useCallback((id: string) => {
    heldUntil.current = Date.now() + 900;
    setActive(id);
  }, []);

  return [active, activate];
}

/** "2 of 3 ready", with a segmented meter, one segment per setup step. */
function Progress({ steps, statuses }: { steps: Section[]; statuses: Partial<Record<SectionKey, SectionStatus>> }) {
  const known = steps.every((s) => statuses[s.key]);
  const done = steps.filter((s) => statuses[s.key]?.state === 'done').length;
  // "Your next paper is on its way" only holds when there is a schedule to make it.
  const allSet = steps.some((s) => s.key === 'schedule') ? 'All set. Your next paper is on its way.' : 'All set.';
  const summary = !known ? 'Checking your setup…' : done === steps.length ? allSet : `${done} of ${steps.length} ready`;
  return (
    <div className="progress">
      <p className="progress-summary">{summary}</p>
      <span className="progress-meter" aria-hidden="true">
        {steps.map((s) => (
          <span key={s.key} className={statuses[s.key]?.state === 'done' ? 'progress-seg is-done' : 'progress-seg'} />
        ))}
      </span>
    </div>
  );
}

function StepDot({ status }: { status: SectionStatus | undefined }) {
  const state = status ? status.state : 'loading';
  return (
    <span className={`step-dot is-${state}`} aria-hidden="true">
      {state === 'done' && (
        <svg width="12" height="12" viewBox="0 0 12 12">
          <path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}

/** What a screen reader hears after the step's name: "done", "to do", or "to do, Reconnect" for a problem. */
function stepStateText(status: SectionStatus | undefined): string {
  if (!status) return 'checking';
  if (status.state === 'done') return 'done';
  return status.tone === 'warn' ? `to do, ${status.label}` : 'to do';
}

/** The setup's name: a weekly paper only when there is a schedule step to make one. */
function setupTitle(steps: Section[]): string {
  return steps.some((s) => s.key === 'schedule') ? 'Your weekly paper' : 'Your setup';
}

/** Phones and tablets: the three setup steps in a row, each jumping to its section. */
function SetupStrip({
  steps,
  statuses,
  progress,
  onJump,
}: {
  steps: Section[];
  statuses: Partial<Record<SectionKey, SectionStatus>>;
  progress: ReactNode;
  onJump: (id: string, e: MouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <nav className="setup" aria-labelledby="setup-title">
      <div className="setup-head">
        <h2 id="setup-title">{setupTitle(steps)}</h2>
        {progress}
      </div>
      <ol className="setup-steps" style={{ '--steps': steps.length } as CSSProperties}>
        {steps.map((s) => {
          const status = statuses[s.key];
          return (
            <li key={s.key} className={status?.state === 'done' ? 'setup-step is-done' : 'setup-step'}>
              <a className="setup-link" href={`#${s.id}`} onClick={(e) => onJump(s.id, e)}>
                <span className="setup-track">
                  <StepDot status={status} />
                  <span className="setup-num" aria-hidden="true">
                    {s.step}
                  </span>
                  <span className="setup-line" aria-hidden="true" />
                </span>
                <span className="setup-label">{s.label}</span>
                <span className="setup-hint">
                  <span className="visually-hidden">: {stepStateText(status)}</span>
                  {/* A problem (lost access, no days, couldn't load) shows its own words instead of the to-do. */}
                  <span aria-hidden="true">{!status ? 'Checking' : status.state === 'done' ? 'Done' : status.tone === 'warn' ? status.label : s.todo}</span>
                </span>
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Desktop: the sticky side panel with setup progress and every section, its status and the one in view. */
function SidePanel({
  sections,
  statuses,
  active,
  progress,
  onJump,
}: {
  sections: Section[];
  statuses: Partial<Record<SectionKey, SectionStatus>>;
  active: string | null;
  progress: ReactNode;
  onJump: (id: string, e: MouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <nav className="settings-panel" aria-label="Settings sections" style={{ '--i': 1 } as CSSProperties}>
      {progress && (
        <div className="panel-progress">
          <p className="panel-kicker">{setupTitle(sections.filter((s) => s.step !== undefined))}</p>
          {progress}
        </div>
      )}
      <ul className="panel-list">
        {sections.map((s) => {
          const status = statuses[s.key];
          const current = active === s.id;
          return (
            <li key={s.key}>
              <a
                className={current ? 'panel-link is-current' : 'panel-link'}
                href={`#${s.id}`}
                aria-current={current ? 'location' : undefined}
                onClick={(e) => onJump(s.id, e)}
              >
                <span className="panel-mark" aria-hidden="true">
                  {s.step ?? (
                    <svg width="11" height="14" viewBox="0 0 12 15">
                      <path d="M1.5 1.5h6l3 3v9h-9z M7.5 1.5v3h3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                <span className="panel-text">
                  <span className="panel-label">{s.label}</span>
                  <span className={status ? `panel-status tone-${status.tone}` : 'panel-status is-loading'}>
                    <span className="visually-hidden">: </span>
                    {status ? status.label : 'Checking…'}
                  </span>
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Phones and tablets: a sticky, sideways-scrolling row of section chips under the header. */
function SectionChips({
  sections,
  active,
  onJump,
}: {
  sections: Section[];
  active: string | null;
  onJump: (id: string, e: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const rowRef = useRef<HTMLUListElement>(null);

  // Keep the current chip in view inside the row, without moving the page.
  useEffect(() => {
    const row = rowRef.current;
    const chip = active ? row?.querySelector<HTMLElement>(`[data-id="${active}"]`) : null;
    if (!row || !chip || row.clientWidth === 0) return;
    const left = chip.offsetLeft - row.offsetLeft;
    if (left < row.scrollLeft || left + chip.offsetWidth > row.scrollLeft + row.clientWidth) {
      row.scrollTo({ left: Math.max(0, left - 16), behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }
  }, [active]);

  return (
    <nav className="settings-chips" aria-label="Settings sections" style={{ '--i': 1 } as CSSProperties}>
      <ul ref={rowRef}>
        {sections.map((s) => (
          <li key={s.key}>
            <a
              className="chip"
              data-id={s.id}
              href={`#${s.id}`}
              aria-current={active === s.id ? 'location' : undefined}
              onClick={(e) => onJump(s.id, e)}
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function SettingsSkeleton() {
  return (
    <div className="settings-body">
      <div className="settings-panel settings-panel-ghost" aria-hidden="true" />
      <div className="settings-main settings-skeleton" aria-busy="true">
        <span className="visually-hidden">Loading your settings…</span>
        <div className="skeleton-card" aria-hidden="true" />
        <div className="skeleton-card" aria-hidden="true" />
        <div className="skeleton-card" aria-hidden="true" />
      </div>
    </div>
  );
}

const SHORT_LAYOUT: Record<PaperLayout, string> = { flat: 'Flat A4', booklet: 'Booklet' };

/** Flat A4: three loose pages, offset, with a staple in the corner. Booklet: a sheet folded down the middle. */
function PaperArt({ layout }: { layout: PaperLayout }) {
  if (layout === 'flat')
    return (
      <svg className="paper-svg" width="120" height="84" viewBox="0 0 120 84" aria-hidden="true">
        <rect x="46" y="6" width="44" height="62" rx="1" className="sheet sheet-back" />
        <rect x="38" y="11" width="44" height="62" rx="1" className="sheet sheet-mid" />
        <rect x="30" y="16" width="44" height="62" rx="1" className="sheet" />
        <path d="M38 30h28M38 36h28M38 42h22M38 50h28M38 56h28M38 62h16" className="sheet-text" />
        <path d="M33.5 24.5l6-6" className="staple" />
      </svg>
    );
  return (
    <svg className="paper-svg" width="120" height="84" viewBox="0 0 120 84" aria-hidden="true">
      <path d="M60 18L22 12v58l38 6z" className="sheet" />
      <path d="M60 18l38-6v58l-38 6z" className="sheet" />
      <path d="M29 24l24 3.5M29 30l24 3.5M29 36l18 2.6M29 44l24 3.5M29 50l24 3.5" className="sheet-text" />
      <path d="M67 27.5l24-3.5M67 33.5l24-3.5M67 39.5l18-2.6M67 47.5l24-3.5M67 53.5l24-3.5" className="sheet-text" />
      <path d="M60 18v58" className="fold" />
    </svg>
  );
}

function PaperSection({
  initial,
  initialLook,
  onStatus,
}: {
  initial: PaperLayout;
  initialLook: PaperLook;
  onStatus?: (s: SectionStatus) => void;
}) {
  const [layout, setLayout] = useState(initial);
  const [look, setLook] = useState(initialLook);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<'shown' | 'fading' | null>(null);
  const timers = useRef<number[]>([]);

  useReportStatus({ state: 'done', tone: 'on', label: SHORT_LAYOUT[layout] }, onStatus);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  function flashSaved() {
    timers.current.forEach(clearTimeout);
    setSaved('shown');
    timers.current = [window.setTimeout(() => setSaved('fading'), 1700), window.setTimeout(() => setSaved(null), 2100)];
  }

  /** Saves one setting, optimistically; on failure it goes back to `previous` and says so. */
  async function save(body: { paperLayout: PaperLayout } | { paperLook: PaperLook }, revert: () => void, failure: string) {
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/me/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        revert();
        setError(await errorText(res, failure));
      } else flashSaved();
    } catch {
      revert();
      setError(failure);
    } finally {
      setSaving(false);
    }
  }

  function choose(next: PaperLayout) {
    if (next === layout || saving) return;
    const previous = layout;
    setLayout(next);
    void save({ paperLayout: next }, () => setLayout(previous), 'Could not save your paper layout.');
  }

  function chooseLook(next: PaperLook) {
    if (next === look || saving) return;
    const previous = look;
    setLook(next);
    void save({ paperLook: next }, () => setLook(previous), 'Could not save your look.');
  }

  const savedNote = (
    <span className={saved === 'shown' ? 'saved is-shown' : 'saved'} aria-live="polite">
      {saved && (
        <>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Saved
        </>
      )}
    </span>
  );

  return (
    <SettingsCard id="paper" title="Paper" description="How your pages are laid out, and how they look." aside={savedNote}>
      {/* The radios stay enabled while saving (choose() ignores clicks then): disabling them would drop keyboard focus. */}
      <fieldset className="paper-choices" aria-busy={saving}>
        <legend className="visually-hidden">Paper layout</legend>
        {LAYOUTS.map((option) => (
          <label key={option.value} className="paper-choice">
            <input
              className="paper-radio"
              type="radio"
              name="paper-layout"
              value={option.value}
              checked={layout === option.value}
              onChange={() => choose(option.value)}
            />
            <span className="paper-art">
              <PaperArt layout={option.value} />
            </span>
            <span className="paper-text">
              <span className="paper-label">{option.label}</span>
              <span className="paper-hint">{option.hint}</span>
            </span>
            <span className="paper-check" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 12 12">
                <path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </label>
        ))}
      </fieldset>
      <h3 className="group-title paper-group-title">Style</h3>
      <fieldset className="paper-choices paper-looks" aria-busy={saving}>
        <legend className="visually-hidden">Magazine style</legend>
        {PAPER_LOOKS.map((option) => (
          <label key={option.value} className="paper-choice">
            <input
              className="paper-radio"
              type="radio"
              name="paper-look"
              value={option.value}
              checked={look === option.value}
              onChange={() => chooseLook(option.value)}
            />
            <span className="paper-art">
              <span className="look-aa" style={{ fontFamily: LOOK_FONTS[option.value].display }} aria-hidden="true">
                Aa<i style={{ background: option.accent }} />
              </span>
            </span>
            <span className="paper-text">
              <span className="paper-label">{option.label}</span>
              <span className="paper-hint">{option.note}</span>
            </span>
            <span className="paper-check" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 12 12">
                <path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </label>
        ))}
      </fieldset>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </SettingsCard>
  );
}
