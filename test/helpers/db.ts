import pg from 'pg';

/** Empties every table in the test database. Refuses to run against anything but *_test. */
export async function resetTestDatabase() {
  const url = process.env.DATABASE_URL ?? '';
  if (!/\/[^/?]+_test(\?|$)/.test(url)) {
    throw new Error(`Refusing to reset a non-test database: ${new URL(url).pathname}`);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ name: string }>(
      `select quote_ident(tablename) as name from pg_tables where schemaname = 'public'`,
    );
    const names = rows.map((r) => r.name);
    await client.query('begin');
    // Append-only guards would block TRUNCATE; switch user triggers off inside the transaction.
    for (const t of names) await client.query(`alter table ${t} disable trigger user`);
    await client.query(`truncate ${names.join(', ')} restart identity cascade`);
    for (const t of names) await client.query(`alter table ${t} enable trigger user`);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    await client.end();
  }
}

/** Runs one query against the test database (for arranging data the API cannot create yet). */
export async function testQuery<T extends pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}
