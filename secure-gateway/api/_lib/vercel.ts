import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'

export type VercelRequest = IncomingMessage & {
  body?: unknown
  headers: IncomingHttpHeaders
  method?: string
  url?: string
}

export type VercelResponse = ServerResponse & {
  status: (statusCode: number) => VercelResponse
  json: (body: unknown) => VercelResponse
}
