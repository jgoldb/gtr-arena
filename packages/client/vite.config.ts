import { defineConfig, type Plugin } from 'vite';
import path from 'path';
import fs from 'fs';

/** Injects a build version constant and writes version.json to the output dir. */
function buildVersionPlugin(): Plugin {
  const version = Date.now().toString();
  return {
    name: 'build-version',
    config() {
      return {
        define: {
          __BUILD_VERSION__: JSON.stringify(version),
        },
      };
    },
    writeBundle(options) {
      const outDir = options.dir || path.resolve(process.cwd(), 'dist');
      fs.writeFileSync(path.join(outDir, 'version.json'), JSON.stringify({ version }));
    },
  };
}

export default defineConfig({
  plugins: [buildVersionPlugin()],
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
