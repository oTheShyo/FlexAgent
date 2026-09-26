import { readFileSync } from 'node:fs'
import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Single source of truth for the displayed app version: package.json.
const { version: appVersion } = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf8')
) as { version: string }

const external = [
  'electron',
  'node-pty',
  '@earendil-works/pi-coding-agent',
  /^@earendil-works\//,
  /^node:/
]

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          worker: resolve(__dirname, 'src/main/worker.ts')
        },
        external
      }
    }
  },
  preload: {
    build: {
      rollupOptions: { external: ['electron', /^node:/] }
    }
  },
  renderer: {
    plugins: [react()],
    define: {
      __APP_VERSION__: JSON.stringify(appVersion)
    },
    build: {
      rollupOptions: {
        external: ['electron']
      }
    }
  }
})
