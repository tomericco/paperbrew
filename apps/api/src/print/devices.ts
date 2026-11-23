import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { config } from '../config.js';
import { isUniqueViolation, pool } from '../db/client.js';
import { requireUser, type UserEnv } from '../routes/library.js';
import { formatPairCode, newDeviceToken, newPairCode, normalizePairCode, sha256 } from './secrets.js';
import { UUID_RE } from '../uuid.js';

/** Hono env for routes behind `requireDevice`: the paired Mac and the user it prints for. */
export type DeviceEnv = { Variables: { deviceId: string; userId: string } };

const CODE_RE = /^[A-Z0-9]{8}$/;
const NAME_MAX = 80;

/**
 * Requires `Authorization: Bearer <device token>` for a device that is not revoked, and sets
 * `deviceId` and `userId`. Only the token's hash is looked up. `last_seen_at` moves at most once a minute.
 */
export const requireDevice = createMiddleware<DeviceEnv>(async (c, next) => {
  const token = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
  if (!token) return c.json({ error: 'unauthorized' }, 401);

  const { rows } = await pool.query<{ id: string; user_id: string }>(
    'select id, user_id from print_devices where token_hash = $1 and revoked_at is null',
    [sha256(token)],
  );
  const device = rows[0];
  if (!device) return c.json({ error: 'unauthorized' }, 401);

  try {
    await pool.query(
      `update print_devices set last_seen_at = now()
       where id = $1 and (last_seen_at is null or last_seen_at < now() - interval '1 minute')`,
      [device.id],
    );
  } catch (err) {
    // A heartbeat that cannot be written must not stop the agent from printing.
    console.warn('[print] could not update last_seen_at', err instanceof Error ? err.message : err);
  }

  c.set('deviceId', device.id);
  c.set('userId', device.user_id);
  await next();
});

export const devices = new Hono<UserEnv>();
devices.use('/me/print-devices', requireUser);
devices.use('/me/print-devices/*', requireUser);

// A short-lived, single-use code the user types into (or opens in) the Mac app.
devices.post('/me/print-devices/pair-code', async (c) => {
  const userId = c.get('userId');
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = newPairCode();
    try {
      const { rows } = await pool.query<{ expires_at: Date }>(
        `insert into print_pair_codes (code_hash, user_id, expires_at)
         values ($1, $2, now() + interval '10 minutes')
         returning expires_at`,
        [sha256(code), userId],
      );
      const link = `paperbrew://pair?code=${code}&api=${encodeURIComponent(config.BETTER_AUTH_URL)}`;
      return c.json({ code: formatPairCode(code), expiresAt: rows[0].expires_at, link });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err; // a hash collision: draw another code
    }
  }
  return c.json({ error: 'could not create a code' }, 500);
});

devices.get('/me/print-devices', async (c) => {
  const { rows } = await pool.query<{ id: string; name: string; created_at: Date; last_seen_at: Date | null }>(
    `select id, name, created_at, last_seen_at
     from print_devices
     where user_id = $1 and revoked_at is null
     order by created_at desc`,
    [c.get('userId')],
  );
  return c.json({
    devices: rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastSeenAt: r.last_seen_at })),
  });
});

devices.delete('/me/print-devices/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'not found' }, 404);
  const { rowCount } = await pool.query(
    'update print_devices set revoked_at = now() where id = $1 and user_id = $2 and revoked_at is null',
    [id, c.get('userId')],
  );
  if (!rowCount) return c.json({ error: 'not found' }, 404);
  return c.body(null, 204);
});

const PairBody = z.object({ code: z.string(), name: z.string().optional() });

// Unauthenticated on purpose: the one-time code is the credential. One paired Mac per user, so a
// successful pairing revokes the user's others.
devices.post('/agent/pair', async (c) => {
  const body = PairBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'code is required' }, 400);

  const gone = () => c.json({ error: 'code expired or used' }, 410);
  const code = normalizePairCode(body.data.code);
  if (!CODE_RE.test(code)) return gone();
  const name = (body.data.name ?? '').trim().slice(0, NAME_MAX).trim() || 'Mac';

  const token = newDeviceToken();
  const client = await pool.connect();
  let rollbackFailed = false;
  try {
    await client.query('begin');
    // Atomic single use: of two requests with the same code, only one updates a row.
    const claim = await client.query<{ user_id: string }>(
      `update print_pair_codes set used_at = now()
       where code_hash = $1 and used_at is null and expires_at > now()
       returning user_id`,
      [sha256(code)],
    );
    const userId = claim.rows[0]?.user_id;
    if (!userId) {
      await client.query('rollback');
      return gone();
    }
    await client.query('update print_devices set revoked_at = now() where user_id = $1 and revoked_at is null', [userId]);
    const ins = await client.query<{ id: string }>(
      'insert into print_devices (user_id, name, token_hash) values ($1, $2, $3) returning id',
      [userId, name, sha256(token)],
    );
    await client.query('commit');
    return c.json({ token, deviceId: ins.rows[0].id }, 201);
  } catch (err) {
    // A failed rollback must not hide the original error; a connection that could not roll back is destroyed.
    rollbackFailed = !(await client.query('rollback').then(() => true, () => false));
    throw err;
  } finally {
    if (rollbackFailed) client.release(true);
    else client.release();
  }
});
