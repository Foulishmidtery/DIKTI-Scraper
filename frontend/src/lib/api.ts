import type {
  AnalysisResponse,
  DosenDetailResponse,
  ProdiDetailResponse,
  HealthResponse,
  OutputFile,
  ScrapeRunsResponse,
  StartJobResponse,
  StreamEvent,
  TargetProdiResponse,
} from '../types'

const API_ORIGIN = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')
const apiUrl = (path: string) => `${API_ORIGIN}${path}`

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  if (window.desktopApi) {
    const body = options?.body ? JSON.parse(String(options.body)) : undefined
    return window.desktopApi.request(options?.method ?? 'GET', path, body) as Promise<T>
  }
  const response = await fetch(apiUrl(path), {
    credentials: 'include',
    ...options,
    headers: { ...(options?.body ? { 'Content-Type': 'application/json' } : {}), ...options?.headers },
  })
  const body = (await response.json().catch(() => ({}))) as { error?: string }
  if (!response.ok) throw new Error(body.error || `Permintaan gagal (${response.status})`)
  return body as T
}

const browserStreams = new Map<string, AbortController>()

async function directStream(jobId: string, listener: (event: StreamEvent) => void) {
  browserStreams.get(jobId)?.abort()
  const controller = new AbortController()
  browserStreams.set(jobId, controller)
  const response = await fetch(apiUrl(`/api/stream/${jobId}`), { signal: controller.signal, credentials: 'include' })
  if (!response.ok || !response.body) throw new Error('Stream job tidak tersedia.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const result = await reader.read()
    if (result.done) break
    buffer += decoder.decode(result.value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const data = block.split('\n').find((line) => line.startsWith('data: '))?.slice(6)
      if (data) listener(JSON.parse(data) as StreamEvent)
      boundary = buffer.indexOf('\n\n')
    }
  }
  browserStreams.delete(jobId)
}

async function downloadOutput(filename: string) {
  let blob: Blob
  if (window.desktopApi) {
    const result = await window.desktopApi.download(filename)
    blob = new Blob([result.bytes], { type: result.mime })
  } else {
    const response = await fetch(apiUrl(`/api/download/${encodeURIComponent(filename)}`), { credentials: 'include' })
    if (!response.ok) throw new Error('File tidak dapat diunduh.')
    blob = await response.blob()
  }
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

export const api = {
  health: () => request<HealthResponse>('/api/health'),
  activateSession: (activationCode: string) => request<{ success: true }>('/api/session', { method: 'POST', body: JSON.stringify({ activation_code: activationCode }) }),
  targets: () => request<TargetProdiResponse>('/api/target-prodi'),
  outputs: () => request<OutputFile[]>('/api/outputs'),
  scrapeRuns: () => request<ScrapeRunsResponse>('/api/scrape-runs?limit=500'),
  analyze: (filename: string) => request<AnalysisResponse>(`/api/analyze/${encodeURIComponent(filename)}`),
  analytics: () => request<AnalysisResponse>('/api/analytics'),
  dosenDetail: (pddiktiId: string, nidn: string) => request<DosenDetailResponse>('/api/analytics/dosen-detail', {
    method: 'POST', body: JSON.stringify({ pddikti_id: pddiktiId, nidn }),
  }),
  prodiDetail: (pddiktiId: string, nama: string, jenjang: string, pt: string) => request<ProdiDetailResponse>('/api/analytics/prodi-detail', {
    method: 'POST', body: JSON.stringify({ pddikti_id: pddiktiId, nama, jenjang, pt }),
  }),
  exportDatabase: () => request<{ success: true; filename: string; size: number; modified: number }>('/api/export', { method: 'POST' }),
  startJob: (prodi: string[]) => request<StartJobResponse>('/api/run-scraper', { method: 'POST', body: JSON.stringify({ prodi }) }),
  stopJob: (jobId: string) => request<{ success: true; message: string }>(`/api/stop-scraper/${jobId}`, { method: 'POST' }),
  deleteOutput: (filename: string) => request<{ success: true }>(`/api/delete-file/${encodeURIComponent(filename)}`, { method: 'DELETE' }),
  downloadOutput,
  streamJob: (jobId: string, listener: (event: StreamEvent) => void, onError: (error: unknown) => void) => {
    const promise = window.desktopApi
      ? window.desktopApi.streamJob(jobId, (event) => listener(event as StreamEvent))
      : directStream(jobId, listener)
    void promise.catch(onError)
    return () => {
      window.desktopApi?.cancelStream(jobId)
      browserStreams.get(jobId)?.abort()
      browserStreams.delete(jobId)
    }
  },
}
