import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist/client',
    rolldownOptions: {
      input: ['index.html', 'docs/index.html', 'install/index.html'].map((file) =>
        fileURLToPath(new URL(file, import.meta.url)),
      ),
    },
  },
  server: {
    host: '127.0.0.1',
    allowedHosts: ['terminal.local'],
  },
  plugins: [react()],
});
