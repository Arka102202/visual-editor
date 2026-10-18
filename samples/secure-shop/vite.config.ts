import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The dev backend (server/index.mjs) answers /api and /files, through Vite's proxy like most real apps.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { proxy: { '/api': 'http://127.0.0.1:4600', '/files': 'http://127.0.0.1:4600' } },
})
