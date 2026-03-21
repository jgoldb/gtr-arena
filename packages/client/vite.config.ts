import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  server: {
    open: true,
    proxy: {
      '/ws': {
        target: 'http://localhost:3001',
        ws: true,
      },
    },
  },
  resolve: {
    alias: {
      '@gtr/shared': path.resolve(__dirname, '../shared/src'),
    },
  },
});
