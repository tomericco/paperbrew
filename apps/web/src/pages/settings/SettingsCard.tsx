import { useEffect } from 'react';
import type { ReactNode } from 'react';

export type StatusTone = 'on' | 'off' | 'warn';

/** A short state shown as a pill on a card and beside its entry in the side panel. */
export type CardStatus = { tone: StatusTone; label: string };

/** What a section tells the page once its data has loaded: the pill, plus whether its setup step is done. */
export type SectionStatus = CardStatus & { state: 'done' | 'todo' };

/** Calls `onStatus` once the section knows its status, and again whenever it changes. */
export function useReportStatus(status: SectionStatus | null, onStatus?: (s: SectionStatus) => void) {
  const key = status ? `${status.state}|${status.tone}|${status.label}` : '';
  useEffect(() => {
    if (status && onStatus) onStatus(status);
    // `key` stands in for `status`, which is a new object on every render.
  }, [key, onStatus]);
}

/** A small sheet of paper, the mark for sections that are not a setup step. */
function SheetGlyph() {
  return (
    <svg width="12" height="15" viewBox="0 0 12 15" aria-hidden="true">
      <path d="M1.5 1.5h6l3 3v9h-9z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M7.5 1.5v3h3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

export function StatusPill({ status }: { status: CardStatus }) {
  return <span className={`pill pill-${status.tone}`}>{status.label}</span>;
}

/**
 * One settings section as a paper slip: a numbered header with a plain-language description and an
 * optional status pill, a hairline, then the section's controls. `id` is the anchor the side panel,
 * the chips and the setup strip jump to.
 */
export function SettingsCard({
  id,
  step,
  title,
  description,
  status,
  aside,
  children,
}: {
  id: string;
  /** The setup-step numeral; sections that are not a step get a sheet glyph instead. */
  step?: number;
  title: string;
  description: string;
  status?: CardStatus;
  /** Extra header content beside the title, e.g. a "Saved" confirmation. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  const titleId = `${id}-title`;
  return (
    <section id={id} className="settings-card" aria-labelledby={titleId} tabIndex={-1}>
      <header className="card-head">
        <span className="card-mark" aria-hidden="true">
          {step ?? <SheetGlyph />}
        </span>
        <div className="card-titles">
          <div className="card-title-row">
            <h2 id={titleId}>{title}</h2>
            {aside}
            {status && <StatusPill status={status} />}
          </div>
          <p className="card-desc">{description}</p>
        </div>
      </header>
      <div className="card-body">{children}</div>
    </section>
  );
}
