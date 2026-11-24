import { useEffect } from 'react';
import { authClient } from '../auth';
import { Layout } from '../Layout';
import { ArchivedList } from './ArchivedList';
import { AccountActions } from './desk/AccountActions';

/**
 * Issues: what was brewed and archived, newest issue first (the Library's old Archived tab).
 * Print history from the Mac stays in Settings > Printer, which owns the reprint flow.
 */
export function Issues() {
  const { data: session, isPending } = authClient.useSession();

  useEffect(() => {
    if (!isPending && !session) location.replace('/signin');
  }, [isPending, session]);

  if (isPending || !session) return <Layout nav="issues">{null}</Layout>;
  return (
    <Layout nav="issues" actions={<AccountActions name={session.user.name} />}>
      <div className="desk-issues">
        <h1>Issues</h1>
        <p className="desk-lede">
          Each issue you brewed and archived, newest first. Move an article back to put it on your reading pile again.
        </p>
        {/* Nothing else on this page lists saved articles, so a moved-back article needs no refresh here. */}
        <ArchivedList onMovedBack={() => {}} />
      </div>
    </Layout>
  );
}
