import { defineConfig, type Plugin, type Connect } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import glsl from 'vite-plugin-glsl';
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// The browser POSTs log lines to /__devlog; they land in .devlog/browser.log so
// engine logs and errors can be read from the terminal without copy-pasting.
function devlog(): Plugin {
  const handler: Connect.NextHandleFunction = (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      appendFileSync('.devlog/browser.log', body.endsWith('\n') ? body : body + '\n');
      res.statusCode = 204;
      res.end();
    });
  };
  return {
    name: 'revoltage-devlog',
    configureServer(server) {
      mkdirSync('.devlog', { recursive: true });
      server.middlewares.use('/__devlog', handler);
    },
    configurePreviewServer(server) {
      mkdirSync('.devlog', { recursive: true });
      server.middlewares.use('/__devlog', handler);
    },
  };
}

// Makes every app entry (src/apps/<name>/index.ts) hot-swappable: when an app or
// anything it imports changes, the engine remounts it with its current params
// instead of reloading the page (devices stay open).
function appHmr(): Plugin {
  return {
    name: 'revoltage-app-hmr',
    apply: 'serve',
    transform(code, id) {
      if (!/\/src\/apps\/[^/]+\/index\.ts$/.test(id)) return;
      return {
        code:
          code +
          '\nif (import.meta.hot) import.meta.hot.accept((m) => { if (m?.default) window.__revoltage?.hotSwap(m.default); });\n',
        map: null,
      };
    },
  };
}

// Dev and preview share one origin (port 5173) so Chrome's device permissions carry over.
export default defineConfig({
  plugins: [svelte(), glsl(), devlog(), appHmr()],
  resolve: { alias: { '@sdk': resolve(import.meta.dirname, 'src/sdk') } },
  server: { port: 5173, strictPort: true },
  preview: { port: 5173, strictPort: true },
  optimizeDeps: { exclude: ['@mediapipe/tasks-vision'] },
  worker: { format: 'es' },
  build: {
    target: 'es2023',
    rollupOptions: { input: { main: 'index.html', output: 'output.html' } },
  },
});
