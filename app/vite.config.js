import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import legacy from '@vitejs/plugin-legacy';

// webOS runs the app from file:// inside a packaged .ipk. Two consequences
// drive this config:
//
//   1. Module scripts are subject to a strict MIME check that fails under
//      file://, producing a blank screen. `renderModernChunks: false` forces
//      classic SystemJS output only, which loads fine.
//   2. Cross-origin resource hints and `crossorigin` attributes are pointless
//      (and occasionally harmful) with no HTTP origin, so we strip them.
//
// Target is webOS 6+ (Chromium 79) per project decision, so we do NOT need the
// chrome53 target or the scrollIntoViewIfNeeded shim that a webOS 4.x build
// requires. Chromium 79 has scrollBehavior, CSS gap, and scrollIntoView
// options natively.
function webosCompat() {
  const polyfill = `<script>
if(typeof globalThis==='undefined'&&typeof window!=='undefined'){window.globalThis=window;}
</script>`;
  return {
    name: 'webos-compat',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        html = html.replace(/\s+crossorigin/g, '');
        html = html.replace(/\s*<link rel="modulepreload"[^>]*>/g, '');
        html = html.replace(/<head>/i, `<head>\n    ${polyfill}`);
        return html;
      }
    }
  };
}

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    legacy({
      // webOS 6+ ships Chromium 79. Keep the ceiling low enough for the oldest
      // supported set but high enough to avoid needless transforms.
      targets: ['chrome >= 79'],
      modernPolyfills: false,
      renderModernChunks: false
    }),
    webosCompat()
  ],
  base: './',
  build: {
    outDir: 'dist',
    target: 'chrome79',
    assetsInlineLimit: 4096,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom']
        }
      }
    }
  },
  server: { host: '0.0.0.0', port: 5173 }
}));
