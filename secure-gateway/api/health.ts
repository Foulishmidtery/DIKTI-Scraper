import type { VercelRequest, VercelResponse } from './_lib/vercel.js'
import { serviceConfigured } from './_lib/auth.js'
import { databaseHealthy } from './_lib/db.js'
import { hardenResponse, methodNotAllowed } from './_lib/http.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  hardenResponse(res)
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
  const configured = serviceConfigured()
  const databaseReady = configured ? await databaseHealthy() : false
  return res.status(configured ? 200 : 503).json({
    success: configured,
    service: 'pddikti-secure-gateway',
    status: databaseReady ? 'ready' : configured ? 'degraded' : 'unavailable',
    database: databaseReady ? 'ready' : 'unavailable',
    server_time: new Date().toISOString(),
  })
}
