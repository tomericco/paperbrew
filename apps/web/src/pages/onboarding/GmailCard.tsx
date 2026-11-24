import { useCallback, useEffect, useState } from 'react';
import { AddressCopy } from './AddressCopy';
import { load } from './api';
import { Card } from './Card';
import { storeStep } from './steps';
import type { CardProps } from './steps';

type Me = { address: string; gmailAvailable: boolean };
type Gmail = { connected: false } | { connected: true; email: string; status: 'active' | 'needs_reconnect' };

const CONNECT_URL = '/api/gmail/connect?from=welcome';

/** What the Google round trip reported in `?gmail=`, read once; `null` when this is not a return from Google. */
function oauthOutcome(): 'connected' | 'error' | null {
  const outcome = new URLSearchParams(location.search).get('gmail');
  return outcome === 'connected' || outcome === 'error' ? outcome : null;
}

/** Newsletters come from Gmail (when the server has it) or from forwarding to the private address. */
export function GmailCard({ next, back }: CardProps) {
  const [outcome] = useState(oauthOutcome);
  const [data, setData] = useState<{ me: Me | null; gmail: Gmail | null } | null>(null);

  // The page is not a return from Google any more once read: leave no ?gmail= behind, or a reload would
  // force this card again. Remember the step instead, so a reload stays here.
  useEffect(() => {
    storeStep('gmail');
    const url = new URL(location.href);
    if (!url.searchParams.has('gmail')) return;
    url.searchParams.delete('gmail');
    history.replaceState(history.state, '', url);
  }, []);

  const fetchAll = useCallback(() => {
    let cancelled = false;
    setData(null);
    Promise.all([load<Me>('/api/me'), load<Gmail>('/api/me/gmail')]).then(([me, gmail]) => {
      if (!cancelled) setData({ me, gmail });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => fetchAll(), [fetchAll]);

  const gmail = data?.gmail ?? null;
  const connected = gmail?.connected === true && gmail.status === 'active';
  const needsReconnect = gmail?.connected === true && gmail.status === 'needs_reconnect';
  // Without /me there is no address to show, so the card cannot do its job: say so and offer a retry.
  const failed = data !== null && data.me === null;
  const canConnect = data?.me?.gmailAvailable === true;

  const footer = (
    <>
      <button type="button" className="ob-link" onClick={back}>
        Back
      </button>
      <span className="ob-grow" />
      <button type="button" className={connected ? 'btn-primary' : undefined} onClick={next}>
        {connected ? 'Continue' : 'Skip for now'}
      </button>
    </>
  );

  let body;
  if (!data) {
    body = (
      <>
        <h2>Where do your reads come from?</h2>
        <p className="ob-muted" role="status">
          Checking your Gmail connection…
        </p>
      </>
    );
  } else if (failed) {
    body = (
      <>
        <h2>Where do your reads come from?</h2>
        <p className="ob-error" role="alert">
          Couldn't load your setup.
        </p>
        <div>
          <button type="button" onClick={fetchAll}>
            Try again
          </button>
        </div>
      </>
    );
  } else if (connected && gmail?.connected) {
    body = (
      <>
        <h2>Gmail is connected</h2>
        <div className="ob-connected">
          <span className="ob-tick is-done" aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.5 6.5l2.2 2.2L9.5 3.8" />
            </svg>
          </span>
          <p>
            Connected as <b className="ob-email">{gmail.email}</b>. Newsletters that arrive from now on are saved.
          </p>
        </div>
        <p className="ob-muted ob-small">Paperbrew only reads your mail. You can disconnect any time in Settings.</p>
      </>
    );
  } else {
    const me = data.me as Me;
    body = (
      <>
        <h2>Where do your reads come from?</h2>
        {outcome === 'error' && (
          <p className="ob-error" role="alert">
            Couldn't connect Gmail. You can try again or skip.
          </p>
        )}
        {needsReconnect && gmail?.connected && (
          <p className="ob-error" role="alert">
            Google asked for a new sign-in for {gmail.email}. Until you reconnect, Paperbrew can't check your newsletters.
          </p>
        )}
        {canConnect ? (
          <>
            <p className="ob-muted">
              Connect Gmail and Paperbrew saves the newsletters you already get. It only reads: it never sends, changes or
              deletes your email, and you can disconnect any time.
            </p>
            <a className="btn btn-primary ob-cta" href={CONNECT_URL}>
              {needsReconnect ? 'Reconnect Gmail' : 'Connect Gmail'}
            </a>
            <p className="ob-muted ob-small ob-or">or save by hand</p>
            <div>
              <p className="ob-muted ob-small ob-label">Forward anything to your private address:</p>
              <AddressCopy address={me.address} />
            </div>
          </>
        ) : (
          <>
            <p className="ob-muted">Forward newsletters and articles to your private address and Paperbrew saves them for you.</p>
            <AddressCopy address={me.address} />
          </>
        )}
      </>
    );
  }

  return (
    <Card step={1} footer={footer}>
      {body}
    </Card>
  );
}
