import type { ReactNode } from 'react';

/** The app shell: header with the brand and page actions, a centered content column, and a footer. */
export function Layout({
  actions,
  centered,
  children,
}: {
  actions?: ReactNode;
  /** Center the content vertically in the space between header and footer. */
  centered?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="shell">
      <header className="header">
        <div className="container">
          <span className="brand">Paperbrew</span>
          {actions && <div className="header-actions">{actions}</div>}
        </div>
      </header>
      <main className={centered ? 'main main-centered' : 'main'}>
        <div className="container">{children}</div>
      </main>
      <footer className="footer">
        <div className="container">© {new Date().getFullYear()} Paperbrew. All rights reserved.</div>
      </footer>
    </div>
  );
}
