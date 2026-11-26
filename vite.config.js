import { defineConfig } from 'vite';

// three.js lives in its own vendor chunk: the engine changes rarely, so it stays
// cached in the browser while the app chunk (sim code) re-deploys, and the app
// chunk no longer trips the chunk-size warning on its own.
export default defineConfig({
  base: './',
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