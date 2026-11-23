import type pg from 'pg';

type Db = pg.Pool | pg.PoolClient;

/** Which path is saving the newsletter: Gmail sync, or a forward/direct email. */
export type SavePath = 'gmail' | 'email';

// The email path never checks inbound_emails: the email being processed is itself stored there with
// its own Message-ID, so that check would always match.
const MESSAGE_ID_SQL: Record<SavePath, string> = {
  gmail: `select 1 from inbound_emails where user_id = $1 and message_id = $2
          union all
          select 1 from articles where user_id = $1 and message_id = $2
          limit 1`,
  email: `select 1 from articles where user_id = $1 and message_id = $2 limit 1`,
};

// The same newsletter reaches us twice when one path saved it and the other later sees a copy.
const TITLE_SQL: Record<SavePath, string> = {
  gmail: `select 1 from articles
          where user_id = $1 and lower(title) = lower($2)
            and created_at > now() - interval '3 days' and added_via <> 'gmail'
          limit 1`,
  email: `select 1 from articles
          where user_id = $1 and lower(title) = lower($2)
            and created_at > now() - interval '3 days' and added_via = 'gmail'
          limit 1`,
};

/**
 * True when this newsletter is already saved: the user has an email or article with the same
 * Message-ID, or the other path saved an article with the same title in the last 3 days.
 * `path` is the path that is saving now.
 */
export async function findDuplicateNewsletter(
  db: Db,
  userId: string,
  n: { messageId: string | null; title: string },
  path: SavePath,
): Promise<boolean> {
  if (n.messageId) {
    const { rows } = await db.query(MESSAGE_ID_SQL[path], [userId, n.messageId]);
    if (rows.length > 0) return true;
  }
  if (n.title.trim()) {
    const { rows } = await db.query(TITLE_SQL[path], [userId, n.title]);
    if (rows.length > 0) return true;
  }
  return false;
}
