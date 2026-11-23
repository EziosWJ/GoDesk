import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import Icons from 'unplugin-icons/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss(), Icons({ compiler: 'jsx', jsx: 'react' })],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8080',
    },
  },
})
