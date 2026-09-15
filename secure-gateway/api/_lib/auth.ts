import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import type { VercelRequest } from './vercel.js'
import { query } from './db.js'
import { header } from './http.js'

const DEVICE_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/
const SESSION_PATTERN = /^[A-Za-z0-9_-]{40,64}$/
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,64}$/
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type AuthenticatedSession = {
  sessionId: string
  deviceId: string
  expiresAt: number
}

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback)
  return Number.isInteger(value) ? Math.min(Math.max(value, min), max) : fallback
}

function masterKey(): string {
  const key = process.env.SESSION_MASTER_KEY?.trim() ?? ''
  if (key.length < 43) throw new Error('server_not_configured')
  return key
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right)
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function sessionSecret(sessionId: string, deviceId: string, expiresAt: number): Buffer {
  return createHmac('sha256', masterKey())
    .update(`${sessionId}|${deviceId}|${expiresAt}`)
    .digest()
}

function clientIp(req: VercelRequest): string {
  const forwarded = header(req, 'x-vercel-forwarded-for') || header(req, 'x-forwarded-for')
  return forwarded.split(',')[0]?.trim() || header(req, 'x-real-ip') || 'unknown'
}

async function rateLimit(key: string, max: number, windowSeconds = 60): Promise<boolean> {
  const safeKey = rateKey(key)
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds)
  const result = await query<{ request_count: number }>(
    `INSERT INTO gateway_rate_limits (rate_key, window_bucket, request_count, expires_at)
     VALUES ($1, $2, 1, NOW() + INTERVAL '2 days')
     ON CONFLICT (rate_key, window_bucket)
     DO UPDATE SET request_count = gateway_rate_limits.request_count + 1
     RETURNING request_count`,
    [safeKey, bucket],
  )
  return Number(result.rows[0]?.request_count ?? max + 1) <= max
}

function rateKey(key: string): string {
  return createHmac('sha256', masterKey()).update(key).digest('hex')
}

export async function allowBootstrap(req: VercelRequest): Promise<boolean> {
  return rateLimit(`bootstrap|${clientIp(req)}`, integerEnv('SESSION_RATE_LIMIT_MAX', 10, 2, 100), 300)
}

export async function allowGateway(req: VercelRequest, sessionId: string): Promise<boolean> {
  return rateLimit(
    `gateway|${clientIp(req)}|${sessionId}`,
    integerEnv('GATEWAY_RATE_LIMIT_MAX', 180, 30, 1_000),
    60,
  )
}

export function validDesktopVersion(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const allowed = (process.env.ALLOWED_DESKTOP_VERSION ?? '').split(',').map((item) => item.trim()).filter(Boolean)
  return allowed.includes(value.trim())
}

export function validActivationCode(value: unknown): boolean {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) return false
  const expectedHex = process.env.DESKTOP_ACTIVATION_CODE_SHA256?.trim().toLowerCase() ?? ''
  if (!/^[0-9a-f]{64}$/.test(expectedHex)) throw new Error('server_not_configured')
  const actual = createHash('sha256').update(value, 'utf8').digest()
  return safeEqual(actual, Buffer.from(expectedHex, 'hex'))
}

export async function issueSession(deviceId: string): Promise<{
  session_id: string
  session_key: string
  expires_at: number
}> {
  if (!DEVICE_PATTERN.test(deviceId)) throw new Error('invalid_device')
  const ttl = integerEnv('SESSION_TTL_SECONDS', 2_700, 300, 7_200)
  const expiresAt = Math.floor(Date.now() / 1000) + ttl
  const sessionId = randomBytes(32).toString('base64url')
  await query(
    `INSERT INTO gateway_sessions (id, device_id, expires_at)
     VALUES ($1, $2, TO_TIMESTAMP($3))`,
    [sessionId, deviceId, expiresAt],
  )
  return {
    session_id: sessionId,
    session_key: sessionSecret(sessionId, deviceId, expiresAt).toString('base64url'),
    expires_at: expiresAt,
  }
}

export async function revokeSession(sessionId: string, req?: VercelRequest): Promise<void> {
  const sessionRateKey = req ? rateKey(`gateway|${clientIp(req)}|${sessionId}`) : null
  try {
    await query('DELETE FROM gateway_sessions WHERE id = $1', [sessionId])
    if (sessionRateKey) {
      await query('DELETE FROM gateway_rate_limits WHERE rate_key = $1 OR expires_at < NOW()', [sessionRateKey])
    }
  } catch {
    await query('UPDATE gateway_sessions SET revoked_at = NOW() WHERE id = $1', [sessionId])
  }
}

export async function verifySignedRequest(req: VercelRequest): Promise<AuthenticatedSession | null> {
  const sessionId = header(req, 'x-session-id').trim()
  const deviceId = header(req, 'x-device-id').trim()
  const timestampText = header(req, 'x-timestamp').trim()
  const nonce = header(req, 'x-nonce').trim()
  const requestId = header(req, 'x-request-id').trim()
  const signatureText = header(req, 'x-signature').trim()

  if (!SESSION_PATTERN.test(sessionId) || !DEVICE_PATTERN.test(deviceId) ||
      !/^\d{10}$/.test(timestampText) || !NONCE_PATTERN.test(nonce) ||
      !REQUEST_ID_PATTERN.test(requestId) || !/^[A-Za-z0-9_-]{43}$/.test(signatureText)) return null

  const now = Math.floor(Date.now() / 1000)
  const timestamp = Number(timestampText)
  const skew = integerEnv('REQUEST_CLOCK_SKEW_SECONDS', 60, 15, 180)
  if (Math.abs(now - timestamp) > skew) return null

  const sessionResult = await query<{ expires_at: string; expires_epoch: string; revoked_at: string | null }>(
    `SELECT expires_at, EXTRACT(EPOCH FROM expires_at)::BIGINT AS expires_epoch, revoked_at
     FROM gateway_sessions WHERE id = $1 AND device_id = $2`,
    [sessionId, deviceId],
  )
  const session = sessionResult.rows[0]
  const expiresAt = Number(session?.expires_epoch ?? 0)
  if (!session || session.revoked_at || expiresAt <= now) return null

  const bodyHash = createHash('sha256').update(canonicalJson(req.body ?? null)).digest('hex')
  const canonical = [req.method ?? '', req.url?.split('?')[0] ?? '', sessionId, deviceId, timestampText, nonce, requestId, bodyHash].join('\n')
  const expected = createHmac('sha256', sessionSecret(sessionId, deviceId, expiresAt)).update(canonical).digest()
  let provided: Buffer
  try {
    provided = Buffer.from(signatureText, 'base64url')
  } catch {
    return null
  }
  if (!safeEqual(expected, provided)) return null

  const replay = await query(
    `INSERT INTO gateway_nonces (session_id, nonce, request_id, expires_at)
     VALUES ($1, $2, $3, TO_TIMESTAMP($4))
     ON CONFLICT DO NOTHING RETURNING nonce`,
    [sessionId, nonce, requestId, expiresAt],
  )
  if (replay.rowCount !== 1) return null

  await query('UPDATE gateway_sessions SET last_seen_at = NOW() WHERE id = $1', [sessionId])
  return { sessionId, deviceId, expiresAt }
}

export function serviceConfigured(): boolean {
  try {
    const url = new URL(process.env.DATABASE_URL?.trim() ?? '')
    return url.protocol === 'postgresql:' && Boolean(url.hostname && url.username && url.password) &&
      masterKey().length >= 43 && /^[0-9a-f]{64}$/i.test(process.env.DESKTOP_ACTIVATION_CODE_SHA256?.trim() ?? '') &&
      (process.env.ALLOWED_DESKTOP_VERSION?.trim().length ?? 0) > 0
  } catch {
    return false
  }
}
