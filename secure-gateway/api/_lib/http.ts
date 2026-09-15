import type { VercelRequest, VercelResponse } from './vercel.js'

export function header(req: VercelRequest, name: string): string {
  const value = req.headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
}

export function hardenResponse(res: VercelResponse): void {
  res.setHeader('Cache-Control', 'no-store, max-age=0')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
}

export function methodNotAllowed(res: VercelResponse, allowed: string): void {
  res.setHeader('Allow', allowed)
  res.status(405).json({ success: false, error: 'Method Not Allowed' })
}

export function bodySizeAllowed(req: VercelRequest): boolean {
  const configured = Number(process.env.MAX_REQUEST_BYTES ?? '1048576')
  const maximum = Number.isInteger(configured) ? Math.min(Math.max(configured, 65_536), 2_000_000) : 1_048_576
  const stated = Number(header(req, 'content-length') || '0')
  if (stated > maximum) return false
  try {
    return Buffer.byteLength(JSON.stringify(req.body ?? null), 'utf8') <= maximum
  } catch {
    return false
  }
}

export function publicError(res: VercelResponse, status: number, message: string): void {
  res.status(status).json({ success: false, error: message })
}
