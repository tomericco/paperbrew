import type { ReactNode } from 'react';
import { Brand } from './Logo';

export type NavPage = 'desk' | 'issues' | 'settings';

const NAV: { page: NavPage; href: string; label: string }[] = [
  { page: 'desk', href: '/app', label: 'Desk' },
  { page: 'issues', href: '/app/issues', label: 'Issues' },
  { page: 'settings', href: '/app/settings', label: 'Settings' },
];

/** The app shell: header with the brand and page actions, a centered content column, and a footer. */
export function Layout({
  actions,
  centered,
  nav,
  children,
}: {
  actions?: ReactNode;
  /** Center the content vertically in the space between header and footer. */
  centered?: boolean;
  /** Show the signed-in app's main nav (Desk, Issues, Settings), with this page marked current. */
  nav?: NavPage;
  children: ReactNode;
}) {
  return (
    <div className="shell">
      <header className="header">
        <div className={nav ? 'container desk-header' : 'container'}>
          <Brand />
          {nav && (
            <nav className="desk-nav" aria-label="Main">
              <ul>
                {NAV.map((item) => (
                  <li key={item.page}>
                    <a href={item.href} aria-current={item.page === nav ? 'page' : undefined}>
                      {item.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          )}
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
