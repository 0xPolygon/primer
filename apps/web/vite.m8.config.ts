import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Local browser check only (untracked): the web app against an API on 3458.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5178,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:3458',
      '/companion': 'http://localhost:3458',
      '/auth': 'http://localhost:3458',
      '/mcp': 'http://localhost:3458',
      '/collab': { target: 'ws://localhost:3458', ws: true },
    },
  },
});
