import type { ReactNode } from 'react';

/** The app shell: header with the brand and page actions, a centered content column, and a footer. */
export function Layout({ actions, children }: { actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="shell">
      <header className="header">
        <div className="container">
          <a className="brand" href="/">
            Paperbrew
          </a>
          {actions && <div className="header-actions">{actions}</div>}
        </div>
      </header>
      <main className="main">
        <div className="container">{children}</div>
      </main>
      <footer className="footer">
        <div className="container">Paperbrew · read on paper</div>
      </footer>
    </div>
  );
}
