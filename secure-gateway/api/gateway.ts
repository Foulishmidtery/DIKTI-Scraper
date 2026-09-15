import type { VercelRequest, VercelResponse } from './_lib/vercel.js'
import { allowGateway, issueSession, revokeSession, verifySignedRequest } from './_lib/auth.js'
import { bodySizeAllowed, hardenResponse, methodNotAllowed, publicError } from './_lib/http.js'
import { runOperation } from './_lib/operations.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  hardenResponse(res)
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
  if (!bodySizeAllowed(req)) return publicError(res, 413, 'Payload terlalu besar.')

  try {
    const session = await verifySignedRequest(req)
    if (!session) return publicError(res, 401, 'Sesi atau signature tidak valid.')
    if (!(await allowGateway(req, session.sessionId))) return publicError(res, 429, 'Terlalu banyak permintaan.')

    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {}
    const action = typeof body.action === 'string' ? body.action : ''
    if (Object.keys(body).some((key) => !['action', 'payload_b64'].includes(key)) || typeof body.payload_b64 !== 'string') {
      return publicError(res, 400, 'Permintaan tidak valid.')
    }
    let payload: unknown
    try {
      if (!/^[A-Za-z0-9_-]{3,1400000}$/.test(body.payload_b64)) throw new Error('bad_payload')
      payload = JSON.parse(Buffer.from(body.payload_b64, 'base64url').toString('utf8'))
    } catch {
      return publicError(res, 400, 'Permintaan tidak valid.')
    }
    if (action === 'refresh_session') {
      const replacement = await issueSession(session.deviceId)
      await revokeSession(session.sessionId, req)
      return res.status(200).json({ success: true, ...replacement })
    }
    if (action === 'revoke_session') {
      await revokeSession(session.sessionId, req)
      return res.status(200).json({ success: true })
    }

    const result = await runOperation(action, payload, session.sessionId)
    return res.status(200).json(result)
  } catch (error) {
    if (error instanceof Error && error.message === 'bad_request') {
      return publicError(res, 400, 'Permintaan tidak valid.')
    }
    return publicError(res, 503, 'Layanan sementara tidak tersedia.')
  }
}
