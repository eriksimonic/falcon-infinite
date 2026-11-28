import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

// Dev-only endpoint that lets the in-game Terrain & Color Paint Editor write its
// `vipava_edits.json` straight into `public/media/` while running `npm run dev`.
// The file is written atomically (tmp + rename) so a failed save can never leave
// a half-written JSON behind for the next page load.
function terrainEditsDevSavePlugin() {
  const OUT_PATH = 'public/media/vipava_edits.json';
  const MAX_BODY_BYTES = 25 * 1024 * 1024;
  return {
    name: 'terrain-edits-dev-save',
    apply: 'serve',
    configureServer(server) {
      const root = server.config.root || process.cwd();
      const outFile = path.resolve(root, OUT_PATH);
      const tmpFile = path.resolve(root, 'public/media/.vipava_edits.json.tmp');

      server.middlewares.use((req, res, next) => {
        if (req.method !== 'POST') return next();
        if ((req.url || '').split('?')[0] !== '/__dev/save-edits') return next();

        let settled = false;
        const reply = (status, payload) => {
          if (settled) return;
          settled = true;
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(payload));
        };

        const chunks = [];
        let bytes = 0;
        req.on('data', (chunk) => {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > MAX_BODY_BYTES) {
            settled = true;
            res.statusCode = 413;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: false, error: 'payload too large (25 MB cap)' }));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        req.on('error', () => reply(500, { ok: false, error: 'request stream failed' }));
        req.on('end', () => {
          if (settled) return;
          const body = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch (err) {
            reply(400, { ok: false, error: `invalid JSON: ${err.message}` });
            return;
          }
          if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) {
            reply(400, { ok: false, error: 'expected an edits object with version === 1' });
            return;
          }
          try {
            fs.mkdirSync(path.dirname(outFile), { recursive: true });
            const out = Buffer.from(JSON.stringify(parsed), 'utf8');
            fs.writeFileSync(tmpFile, out);
            fs.renameSync(tmpFile, outFile);
            reply(200, { ok: true, bytes: out.length, path: OUT_PATH });
          } catch (err) {
            reply(500, { ok: false, error: err && err.message ? err.message : 'write failed' });
          }
        });
      });
    },
  };
}

// three.js lives in its own vendor chunk: the engine changes rarely, so it stays
// cached in the browser while the app chunk (sim code) re-deploys, and the app
// chunk no longer trips the chunk-size warning on its own.
export default defineConfig({
  base: './',
  plugins: [terrainEditsDevSavePlugin()],
  build: {
    // three.js alone is ~590 kB minified even tree-shaken, so the vendor chunk
    // is expected to sit above Rollup's default 500 kB warning line.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'vendor-three';
          return null;
        },
      },
    },
  },
});