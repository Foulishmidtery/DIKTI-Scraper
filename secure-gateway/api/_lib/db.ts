import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg'

type GlobalWithPool = typeof globalThis & { __pddiktiGatewayPool?: Pool }

function databaseUrl(): string {
  const raw = process.env.DATABASE_URL?.trim() ?? ''
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('server_not_configured')
  }
  if (parsed.protocol !== 'postgresql:' || !parsed.hostname || !parsed.username || !parsed.password) {
    throw new Error('server_not_configured')
  }
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) {
    parsed.searchParams.delete(key)
  }
  return parsed.toString()
}

function tlsOptions(): { rejectUnauthorized: true; ca?: string } {
  const encodedCa = process.env.POSTGRES_CA_CERT?.trim()
  return encodedCa
    ? { rejectUnauthorized: true, ca: encodedCa.replace(/\\n/g, '\n') }
    : { rejectUnauthorized: true }
}

export function getPool(): Pool {
  const globalPool = globalThis as GlobalWithPool
  if (!globalPool.__pddiktiGatewayPool) {
    globalPool.__pddiktiGatewayPool = new Pool({
      connectionString: databaseUrl(),
      ssl: tlsOptions(),
      max: 5,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 20_000,
      allowExitOnIdle: true,
    })
  }
  return globalPool.__pddiktiGatewayPool
}

export async function query<Row extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<QueryResult<Row>> {
  return getPool().query<Row>(text, values)
}

export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function databaseHealthy(): Promise<boolean> {
  try {
    await query('SELECT 1')
    return true
  } catch {
    return false
  }
}
