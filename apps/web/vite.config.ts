import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const apiTarget = process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3000'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Same-origin in dev too: the app calls /api/v1 (see src/services/api.ts)
    // and Vite forwards it (media is served under /api/v1 too) plus socket.io.
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/socket.io': { target: apiTarget, changeOrigin: true, ws: true },
    },
  },
})
