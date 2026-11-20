import { useEffect, useRef, useState } from 'react';
import { LogoMark } from '../Logo';

const HEADLINES = ['Fresh off the press.', 'Your issue is brewed.', 'Hot off the press, ready to pour.'];

/** How long "Archived. Your queue is clear." shows before the dialog closes itself. */
const DONE_MS = 1200;

type Phase = 'idle' | 'archiving' | 'done' | 'error';

/**
 * Shown once a brew has downloaded: celebrates the issue and offers to archive exactly the articles in it.
 * A native modal <dialog>: Esc, a press on the backdrop and "Keep in queue" all close it without archiving.
 * `onArchive` should reject when archiving fails; the dialog then stays open with an error.
 */
export function BrewedDialog({
  count,
  onArchive,
  onClose,
}: {
  count: number;
  onArchive: () => Promise<void>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const archiveRef = useRef<HTMLButtonElement>(null);
  const pressedBackdropRef = useRef(false);
  const doneTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [headline] = useState(() => HEADLINES[Math.floor(Math.random() * HEADLINES.length)]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [pouring, setPouring] = useState(true);
  const busy = phase === 'archiving' || phase === 'done';

  useEffect(() => {
    const dialog = dialogRef.current;
    // Guarded: StrictMode runs this twice, and the dialog must not be closed in a cleanup (that would fire onClose).
    if (dialog && !dialog.open) dialog.showModal();
    return () => clearTimeout(doneTimerRef.current);
  }, []);

  useEffect(() => {
    // The focused button was disabled while archiving, so put focus back somewhere useful.
    if (phase === 'done') statusRef.current?.focus();
    if (phase === 'error') archiveRef.current?.focus();
  }, [phase]);

  function close() {
    dialogRef.current?.close();
  }

  async function archive() {
    setPhase('archiving');
    try {
      await onArchive();
    } catch {
      setPhase('error');
      return;
    }
    setPhase('done');
    setPouring(true);
    doneTimerRef.current = setTimeout(close, DONE_MS);
  }

  const articles = count === 1 ? '1 article' : `${count} articles`;

  return (
    <dialog
      ref={dialogRef}
      className="brewed"
      aria-labelledby="brewed-title"
      aria-describedby="brewed-text"
      onClose={onClose}
      onCancel={(e) => {
        // Esc mid-archive would hide the result; let it finish.
        if (busy) e.preventDefault();
      }}
      onPointerDown={(e) => {
        pressedBackdropRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // The dialog has no padding of its own, so a press that starts and ends on it is on the backdrop.
        if (e.target === e.currentTarget && pressedBackdropRef.current && !busy) close();
      }}
    >
      <div className="brewed-body">
        <span className="brewed-mark">
          <LogoMark size={44} pouring={pouring} onPourEnd={() => setPouring(false)} />
        </span>
        <h2 id="brewed-title" className="brewed-title">
          {headline}
        </h2>
        <p id="brewed-text" className="brewed-text">
          {count > 0
            ? `${articles}, ready to print. Archive them to start your next issue fresh.`
            : 'Your issue is ready to print.'}
        </p>
        {phase === 'done' ? (
          <p className="brewed-done" role="status" tabIndex={-1} ref={statusRef}>
            Archived. Your queue is clear.
          </p>
        ) : (
          <>
            {phase === 'error' && (
              <p className="error brewed-error" role="alert">
                Couldn't archive. Try again.
              </p>
            )}
            <div className="brewed-actions">
              {count > 0 && (
                <button type="button" className="btn-primary" ref={archiveRef} onClick={archive} disabled={busy}>
                  {phase === 'archiving'
                    ? 'Archiving…'
                    : count === 1
                      ? 'Archive this article'
                      : `Archive these ${count} articles`}
                </button>
              )}
              <button type="button" onClick={close} disabled={busy}>
                {count > 0 ? 'Keep in queue' : 'Close'}
              </button>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}
