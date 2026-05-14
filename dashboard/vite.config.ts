import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react()],
  base: '/dashboard/',
  build: {
    outDir: resolve(__dirname, '../dist-dashboard'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/dashboard/api': {
        target: `http://localhost:${process.env['BACKEND_PORT'] ?? 8050}`,
        changeOrigin: true,
      },
    },
  },
});
