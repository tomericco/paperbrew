import { useEffect, useState } from 'react';
import { usePairing } from '../usePairing';
import { load } from './api';
import { Card } from './Card';
import type { CardProps } from './steps';

type Me = { scheduleAvailable: boolean; macAppUrl: string | null };
type Schedule = { enabled: boolean; days: number[] };

const NOTICE = 'Scheduled issues only brew while a Mac is connected. You can still brew by hand and download the PDF.';

/**
 * The Mac app: download it, then "Connect this Mac" hands a one-time code to the app and waits for it to pair
 * (the pairing flow is the one Settings uses). A Mac that is paired already shows as ready.
 */
export function PrinterCard({ next, back }: CardProps) {
  const { devices, loadError, pairing, connecting, showHelp, timedOut, copied, error, connect, copyCode } = usePairing();
  // The app link and whether a schedule is waiting on this Mac; null until both are known.
  const [info, setInfo] = useState<{ macAppUrl: string | null; scheduleOn: boolean } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      const me = await load<Me>('/api/me', controller.signal);
      const schedule = me?.scheduleAvailable === false ? null : await load<Schedule>('/api/me/schedule', controller.signal);
      if (controller.signal.aborted) return;
      setInfo({ macAppUrl: me?.macAppUrl ?? null, scheduleOn: !!schedule && schedule.enabled && schedule.days.length > 0 });
    })();
    return () => controller.abort();
  }, []);

  const mac = devices?.[0];
  const ready = (devices !== null || loadError !== '') && info !== null;

  const footer = (
    <>
      <button type="button" className="ob-link" onClick={back}>
        Back
      </button>
      <span className="ob-grow" />
      <button type="button" className={mac ? 'btn-primary' : undefined} onClick={next}>
        {mac ? 'Continue' : 'Do this later'}
      </button>
    </>
  );

  return (
    <Card step={5} footer={footer}>
      <h2>Where should it print?</h2>
      <p className="ob-muted">
        {mac
          ? 'Issues print here on schedule. Keep the printer on and stocked with paper.'
          : 'A small Mac app prints your issues on the printer already at home, any brand. Install it once, then click connect.'}
      </p>
      {loadError ? (
        <p className="ob-error" role="alert">
          Couldn't load your printer. You can set this up later in Settings.
        </p>
      ) : !ready ? (
        <p className="ob-muted" role="status">
          Loading…
        </p>
      ) : mac ? (
        <div className="ob-connected" role="status">
          <span className="ob-tick is-done" aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.5 6.5l2.2 2.2L9.5 3.8" />
            </svg>
          </span>
          <span className="ob-email">
            Your Mac is ready: <b>{mac.name}</b>
          </span>
        </div>
      ) : (
        <>
          <div className="ob-stack">
            {info?.macAppUrl && (
              <a className="btn ob-cta" href={info.macAppUrl}>
                Download for Mac
              </a>
            )}
            <button type="button" className="btn-primary ob-cta" onClick={() => void connect()} disabled={connecting}>
              Connect this Mac
            </button>
          </div>
          {pairing && (
            <div className="ob-wait" role="status">
              <p className="ob-wait-line">
                <span className="ob-dot" aria-hidden="true" />
                Waiting for the Paperbrew app…
              </p>
              {showHelp && (
                <div className="ob-help">
                  <p>Didn't open? Install the app first, then click Connect again.</p>
                  <p className="ob-muted">Or open the app and paste this code:</p>
                  <div className="ob-address-row">
                    <code className="ob-address-code">{pairing.code}</code>
                    <button type="button" className="ob-copy" onClick={() => void copyCode(pairing.code)}>
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {timedOut && <p className="ob-muted">The app didn't connect. Click Connect this Mac to try again.</p>}
          <p className="ob-error" role="alert">
            {error}
          </p>
          {info?.scheduleOn && <p className="ob-notice">{NOTICE}</p>}
        </>
      )}
    </Card>
  );
}
