import type pg from 'pg';
import { isUniqueViolation, pool } from '../db/client.js';
import { newToken } from '../inbound/address.js';
import { accountEmail } from './providers.js';

const MAX_ATTEMPTS = 5;

type Db = { connect(): Promise<Pick<pg.PoolClient, 'query' | 'release'>> };

/**
 * Create our `users` row and a word-token forwarding address for a new Better Auth user.
 * Runs from the `user.create.after` hook. A second call for the same auth user is a no-op.
 * A token collision rolls back and retries with a fresh token; any other error is thrown.
 */
export async function provisionUser(authUser: { id: string; email: string }, db: Db = pool): Promise<void> {
  const email = accountEmail(authUser.email);

  for (let attempt = 1; ; attempt++) {
    const client = await db.connect();
    let insertingAddress = false;
    try {
      await client.query('begin');
      const { rows } = await client.query<{ id: string }>(
        `insert into users (auth_user_id, email) values ($1, $2)
         on conflict (auth_user_id) do nothing
         returning id`,
        [authUser.id, email],
      );
      if (rows[0]) {
        insertingAddress = true;
        await client.query('insert into inbound_addresses (user_id, token) values ($1, $2)', [rows[0].id, newToken()]);
      }
      await client.query('commit');
      return;
    } catch (err) {
      await client.query('rollback');
      if (insertingAddress && isUniqueViolation(err) && attempt < MAX_ATTEMPTS) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}
