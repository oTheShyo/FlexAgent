import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

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
    build: {
      rollupOptions: {
        external: ['electron']
      }
    }
  }
})
