import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // The relay (spec 0008) is run by an AI assistant with plain `node`, next to the main bundle.
        input: { index: resolve('src/main/index.ts'), relay: resolve('src/relay/relay.ts') }
      }
    }
  },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: { plugins: [react()] }
})
