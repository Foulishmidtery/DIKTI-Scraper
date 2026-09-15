import type { VercelRequest, VercelResponse } from './_lib/vercel.js'
import { allowBootstrap, issueSession, validActivationCode, validDesktopVersion } from './_lib/auth.js'
import { bodySizeAllowed, hardenResponse, methodNotAllowed, publicError } from './_lib/http.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  hardenResponse(res)
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
  if (!bodySizeAllowed(req)) return publicError(res, 413, 'Payload terlalu besar.')

  try {
    if (!(await allowBootstrap(req))) return publicError(res, 429, 'Terlalu banyak percobaan.')
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {}
    if (!validDesktopVersion(body.desktop_version)) return publicError(res, 426, 'Versi aplikasi tidak didukung.')
    if (!validActivationCode(body.activation_code)) return publicError(res, 401, 'Kode aktivasi tidak valid.')
    if (typeof body.device_id !== 'string') return publicError(res, 400, 'Permintaan tidak valid.')

    const session = await issueSession(body.device_id)
    return res.status(200).json({
      success: true,
      ...session,
      server_time: Math.floor(Date.now() / 1000),
    })
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : 'unknown'
    console.error('session_bootstrap_failed', code)
    return publicError(res, 503, 'Layanan sementara tidak tersedia.')
  }
}
