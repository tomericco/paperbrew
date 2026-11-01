import { describe, expect, it, vi } from 'vitest';

// provision.ts imports the DB pool, which reads config at import time. A fake pool is passed in instead.
vi.mock('../src/config.js', () => ({
  config: { DATABASE_URL: 'postgres://localhost:5432/test' },
}));

const { provisionUser } = await import('../src/auth/provision.js');

type Call = { sql: string; params?: unknown[] };

/** A pg-like pool whose client records queries and answers with `respond`. */
function fakePool(respond: (call: Call) => { rows: unknown[] } | Error) {
  const calls: Call[] = [];
  let releases = 0;
  const client = {
    async query(sql: string, params?: unknown[]) {
      const call = { sql: sql.replace(/\s+/g, ' ').trim(), params };
      calls.push(call);
      const result = respond(call);
      if (result instanceof Error) throw result;
      return result;
    },
    release() {
      releases++;
    },
  };
  return { pool: { connect: async () => client }, calls, releases: () => releases };
}

function uniqueViolation(constraint: string) {
  return Object.assign(new Error('duplicate key'), { code: '23505', constraint });
}

const ok = { rows: [] };

describe('provisionUser', () => {
  it('creates the user and an address in one transaction', async () => {
    const db = fakePool(({ sql }) => (sql.startsWith('insert into users') ? { rows: [{ id: 'u1' }] } : ok));
    await provisionUser({ id: 'auth-1', email: 'Me@Example.com' }, db.pool);

    expect(db.calls.map((c) => c.sql.split(' ').slice(0, 3).join(' '))).toEqual([
      'begin',
      'insert into users',
      'insert into inbound_addresses',
      'commit',
    ]);
    expect(db.calls[1].params).toEqual(['auth-1', 'me@example.com']);
    expect(db.calls[2].params?.[0]).toBe('u1');
    expect(db.calls[2].params?.[1]).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
    expect(db.releases()).toBe(1);
  });

  it('stores a null email for placeholder addresses', async () => {
    const db = fakePool(({ sql }) => (sql.startsWith('insert into users') ? { rows: [{ id: 'u1' }] } : ok));
    await provisionUser({ id: 'auth-2', email: 'reddit-abc@users.paperbrew.invalid' }, db.pool);
    expect(db.calls[1].params).toEqual(['auth-2', null]);
  });

  it('does nothing more when the user already exists', async () => {
    const db = fakePool(() => ok); // on conflict do nothing -> no row returned
    await provisionUser({ id: 'auth-1', email: 'me@example.com' }, db.pool);
    expect(db.calls.some((c) => c.sql.startsWith('insert into inbound_addresses'))).toBe(false);
    expect(db.calls.at(-1)?.sql).toBe('commit');
  });

  it('retries with a fresh token when the token is taken', async () => {
    let addressInserts = 0;
    const db = fakePool(({ sql }) => {
      if (sql.startsWith('insert into users')) return { rows: [{ id: 'u1' }] };
      if (sql.startsWith('insert into inbound_addresses') && ++addressInserts < 3) {
        return uniqueViolation('inbound_addresses_token_key');
      }
      return ok;
    });
    await provisionUser({ id: 'auth-1', email: 'me@example.com' }, db.pool);
    expect(addressInserts).toBe(3);
    expect(db.calls.filter((c) => c.sql === 'rollback')).toHaveLength(2);
    expect(db.calls.at(-1)?.sql).toBe('commit');
    expect(db.releases()).toBe(3);
  });

  it('gives up after 5 token collisions', async () => {
    const db = fakePool(({ sql }) => {
      if (sql.startsWith('insert into users')) return { rows: [{ id: 'u1' }] };
      if (sql.startsWith('insert into inbound_addresses')) return uniqueViolation('inbound_addresses_token_key');
      return ok;
    });
    await expect(provisionUser({ id: 'auth-1', email: 'me@example.com' }, db.pool)).rejects.toThrow('duplicate key');
    expect(db.calls.filter((c) => c.sql.startsWith('insert into inbound_addresses'))).toHaveLength(5);
    expect(db.releases()).toBe(5);
  });

  it('does not retry other unique violations, such as a taken email', async () => {
    const db = fakePool(({ sql }) =>
      sql.startsWith('insert into users') ? uniqueViolation('users_email_key') : ok,
    );
    await expect(provisionUser({ id: 'auth-1', email: 'me@example.com' }, db.pool)).rejects.toThrow('duplicate key');
    expect(db.calls.filter((c) => c.sql.startsWith('insert into users'))).toHaveLength(1);
    expect(db.calls.at(-1)?.sql).toBe('rollback');
  });
});
