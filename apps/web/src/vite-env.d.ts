/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute or same-origin base of the REST API, e.g. https://api.example.com/api/v1. Defaults to /api/v1. */
  readonly VITE_API_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
