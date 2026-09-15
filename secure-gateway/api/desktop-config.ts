import type { VercelRequest, VercelResponse } from './_lib/vercel.js'
import { hardenResponse } from './_lib/http.js'

export default function handler(_req: VercelRequest, res: VercelResponse) {
  hardenResponse(res)
  return res.status(410).json({
    success: false,
    error: 'Endpoint konfigurasi credential telah dinonaktifkan. Gunakan secure gateway.',
  })
}
