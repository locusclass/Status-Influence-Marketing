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
`;

export async function ensurePublicIdColumns(client: any) {
  await client.query(ensurePublicIdFunctionSql);

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
      SET DEFAULT generate_pronounceable_public_id('usr')
  `);
  await client.query(`
    ALTER TABLE campaigns
      ALTER COLUMN public_id
      SET DEFAULT generate_pronounceable_public_id('cmp')
  `);

  await client.query(`
    UPDATE users
    SET public_id = generate_pronounceable_public_id('usr')
    WHERE public_id IS NULL OR btrim(public_id) = ''
  `);
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

export async function resolveUserId(client: any, identifier: string) {
  const value = String(identifier ?? '').trim();
  if (!value) {
    return null;
  }
  const res = await client.query(
    `
    SELECT id
    FROM users
    WHERE id::text = $1 OR public_id = $1
    LIMIT 1
    `,
    [value]
  );
  return (res.rows[0]?.id as string | undefined) ?? null;
}

export async function resolveCampaignId(client: any, identifier: string) {
  const value = String(identifier ?? '').trim();
  if (!value) {
    return null;
  }
  const res = await client.query(
    `
    SELECT id
    FROM campaigns
    WHERE id::text = $1 OR public_id = $1
    LIMIT 1
    `,
    [value]
  );
  return (res.rows[0]?.id as string | undefined) ?? null;
}
