const ensurePublicIdFunctionSql = `
CREATE OR REPLACE FUNCTION generate_pronounceable_public_id(prefix TEXT)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  consonants TEXT[] := ARRAY[
    'b','d','f','g','k','l','m','n','p','r','s','t','v','z'
  ];
  vowels TEXT[] := ARRAY['a','e','i','o','u'];
  output TEXT := lower(prefix) || '-';
  idx INTEGER;
BEGIN
  FOR idx IN 1..4 LOOP
    output := output
      || consonants[1 + floor(random() * array_length(consonants, 1))::int]
      || vowels[1 + floor(random() * array_length(vowels, 1))::int];
  END LOOP;

  output := output || lpad(floor(random() * 100)::int::text, 2, '0');
  RETURN output;
END;
$$;

CREATE OR REPLACE FUNCTION generate_random_user_numeric_public_id()
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  candidate TEXT;
BEGIN
  LOOP
    candidate := (
      floor(random() * 9000000000)::bigint + 1000000000
    )::text;

    EXIT WHEN NOT EXISTS (
      SELECT 1
      FROM users
      WHERE public_id = candidate
    );
  END LOOP;

  RETURN candidate;
END;
$$;
`;
export async function ensurePublicIdColumns(client) {
    // This helper is called from request paths. Serialize the migration body so
    // concurrent logins do not try to rewrite the same rows at once.
    await client.query(`
    SELECT pg_advisory_xact_lock(hashtext('ensure_public_id_columns_v1')::bigint)
  `);
    await client.query(ensurePublicIdFunctionSql);
    await client.query(`
    CREATE TABLE IF NOT EXISTS system_flags (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
    await client.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS public_id TEXT
  `);
    await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS public_id TEXT
  `);
    await client.query(`
    ALTER TABLE users
      ALTER COLUMN public_id
      SET DEFAULT generate_random_user_numeric_public_id()
  `);
    await client.query(`
    ALTER TABLE campaigns
      ALTER COLUMN public_id
      SET DEFAULT generate_pronounceable_public_id('cmp')
  `);
    const randomizedFlag = await client.query(`
    SELECT 1
    FROM system_flags
    WHERE key = 'users_public_id_randomized_v1'
    LIMIT 1
    `);
    if (!randomizedFlag.rows[0]) {
        const existingUsers = await client.query(`
      SELECT id
      FROM users
      ORDER BY created_at ASC, id ASC
    `);
        for (const row of existingUsers.rows) {
            await client.query(`
        UPDATE users
        SET public_id = generate_random_user_numeric_public_id()
        WHERE id = $1
        `, [row.id]);
        }
        await client.query(`
      INSERT INTO system_flags (key, value, updated_at)
      VALUES (
        'users_public_id_randomized_v1',
        '{"randomized": true}'::jsonb,
        NOW()
      )
      ON CONFLICT (key)
      DO UPDATE SET
        value = EXCLUDED.value,
        updated_at = NOW()
      `);
    }
    const invalidUsers = await client.query(`
    SELECT id
    FROM users
    WHERE public_id IS NULL
       OR btrim(public_id) = ''
       OR public_id !~ '^[1-9][0-9]{9}$'
    ORDER BY created_at ASC, id ASC
  `);
    for (const row of invalidUsers.rows) {
        await client.query(`
      UPDATE users
      SET public_id = generate_random_user_numeric_public_id()
      WHERE id = $1
      `, [row.id]);
    }
    await client.query(`
    UPDATE campaigns
    SET public_id = generate_pronounceable_public_id('cmp')
    WHERE public_id IS NULL OR btrim(public_id) = ''
  `);
    await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_users_public_id
    ON users(public_id)
  `);
    await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_campaigns_public_id
    ON campaigns(public_id)
  `);
    await client.query(`
    ALTER TABLE users
      ALTER COLUMN public_id SET NOT NULL
  `);
    await client.query(`
    ALTER TABLE campaigns
      ALTER COLUMN public_id SET NOT NULL
  `);
}
export async function resolveUserId(client, identifier) {
    const value = String(identifier ?? '').trim();
    if (!value) {
        return null;
    }
    const res = await client.query(`
    SELECT id
    FROM users
    WHERE id::text = $1 OR public_id = $1
    LIMIT 1
    `, [value]);
    return res.rows[0]?.id ?? null;
}
export async function resolveCampaignId(client, identifier) {
    const value = String(identifier ?? '').trim();
    if (!value) {
        return null;
    }
    const res = await client.query(`
    SELECT id
    FROM campaigns
    WHERE id::text = $1 OR public_id = $1
    LIMIT 1
    `, [value]);
    return res.rows[0]?.id ?? null;
}
