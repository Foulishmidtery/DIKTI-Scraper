/// <reference types="vite/client" />

interface Window {
  desktopApi?: {
    request: (method: string, path: string, body?: unknown) => Promise<unknown>
    streamJob: (jobId: string, listener: (event: unknown) => void) => Promise<void>
    cancelStream: (jobId: string) => void
    download: (filename: string) => Promise<{ bytes: Uint8Array; mime: string }>
  }
}
