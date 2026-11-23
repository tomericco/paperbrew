import { useEffect, useState } from 'react';
import { authClient } from '../auth';
import { Layout } from '../Layout';
import { errorText, LAYOUTS } from './layouts';
import type { PaperLayout } from './layouts';
import { GmailSection } from './settings/GmailSection';
import { PrinterSection } from './settings/PrinterSection';
import { ScheduleSection } from './settings/ScheduleSection';

type Me = { paperLayout: PaperLayout; gmailAvailable: boolean; scheduleAvailable: boolean; macAppUrl: string | null };

const NOTICES: Record<string, string> = {
  connected: 'Gmail connected. New newsletters will appear within the hour.',
  error: "Couldn't connect Gmail. Try again.",
};

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

  return (
    <Layout actions={header}>
      <div className="grid">
        <section className="span-12 settings">
          <h1>Settings</h1>
          <div role="status" className="settings-status">
            {notice && <p className="notice">{notice}</p>}
          </div>
          {loadError ? (
            <p className="error">{loadError}</p>
          ) : !me ? (
            <p className="muted">Loading…</p>
          ) : (
            <>
              <PaperSection initial={me.paperLayout} />
              <PrinterSection macAppUrl={me.macAppUrl} />
              {me.scheduleAvailable && <ScheduleSection />}
              {me.gmailAvailable && <GmailSection />}
            </>
          )}
        </section>
      </div>
    </Layout>
  );
}

function PaperSection({ initial }: { initial: PaperLayout }) {
  const [layout, setLayout] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function choose(next: PaperLayout) {
    if (next === layout || saving) return;
    const previous = layout;
    setLayout(next);
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/me/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paperLayout: next }),
      });
      if (!res.ok) {
        setLayout(previous);
        setError(await errorText(res, 'Could not save your paper layout.'));
      }
    } catch {
      setLayout(previous);
      setError('Could not save your paper layout.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings-section" aria-labelledby="settings-paper">
      <h2 id="settings-paper">Paper</h2>
      <fieldset className="choices" disabled={saving}>
        <legend className="visually-hidden">Paper layout</legend>
        {LAYOUTS.map((option) => (
          <label key={option.value} className="choice">
            <input
              type="radio"
              name="paper-layout"
              value={option.value}
              checked={layout === option.value}
              onChange={() => void choose(option.value)}
            />
            <span className="choice-text">
              <span className="choice-label">{option.label}</span>
              <span className="choice-hint">{option.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
