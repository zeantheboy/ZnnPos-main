import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { cwd } from 'node:process'
import { loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, cwd(), '')
  const port = Number(env.PORT || env.VITE_PORT || 4173)

  return {
    plugins: [react()],
    base: './',
    server: {
      host: '0.0.0.0',
      port,
      strictPort: false
    }
  }
})
