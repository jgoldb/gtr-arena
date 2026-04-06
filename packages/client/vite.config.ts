import { defineConfig, type Plugin } from 'vite';
import path from 'path';
import fs from 'fs';

/**
 * Serves onnxruntime-web WASM/JS files directly from node_modules.
 * Vite's dev server intercepts dynamic imports of .mjs files and tries to process
 * them through its module graph, which breaks ort-web's internal WASM loading.
 * This plugin short-circuits those requests and serves the files with correct MIME types.
 */
function ortWasmPlugin(): Plugin {
  const ortDistDir = path.resolve(__dirname, '../../node_modules/onnxruntime-web/dist');
  return {
    name: 'ort-wasm-serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0];
        if (url?.startsWith('/ort-wasm-')) {
          const filePath = path.join(ortDistDir, url.substring(1));
          if (fs.existsSync(filePath)) {
            const ext = path.extname(filePath);
            const mime: Record<string, string> = {
              '.wasm': 'application/wasm',
              '.mjs': 'application/javascript',
              '.js': 'application/javascript',
            };
            res.setHeader('Content-Type', mime[ext] || 'application/octet-stream');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            fs.createReadStream(filePath).pipe(res);
            return;
          }
        }
        next();
      });
    },
    writeBundle(options) {
      // Copy ort-wasm files to build output so they're available in production
      const outDir = options.dir || path.resolve(process.cwd(), 'dist');
      const files = fs.readdirSync(ortDistDir).filter(f => f.startsWith('ort-wasm-'));
      for (const file of files) {
        fs.copyFileSync(path.join(ortDistDir, file), path.join(outDir, file));
      }
    },
  };
}

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
  plugins: [ortWasmPlugin(), buildVersionPlugin()],
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
