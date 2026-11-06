import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // RFC-0010 §6: Service Worker with injectManifest strategy.
      strategies: 'injectManifest',
      srcDir: 'src/workers',
      filename: 'sw.ts',
      injectRegister: false,
      manifest: false,
      injectManifest: {
        // Workbox will inject the precache manifest into the SW build.
        injectionPoint: 'self.__WB_MANIFEST',
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
        globIgnores: ['**/crypto.worker*', '**/device-check*'],
      },
      devOptions: {
        enabled: false, // SW disabled in dev; use npm run build to test.
      },
    }),
    {
      name: 'inject-device-check-loader',
      transformIndexHtml: {
        order: 'post',
        handler(html, ctx) {
          if (!ctx.filename.endsWith('device-check.html')) return html;
          let loaderPath = '';
          if (ctx.bundle) {
            for (const [key, item] of Object.entries(ctx.bundle)) {
              if (item.name === 'deviceCheckLoader' || key.includes('deviceCheckLoader')) {
                loaderPath = `/${item.fileName}`;
                break;
              }
            }
          } else {
            loaderPath = '/src/device-check-loader.ts';
          }
          if (loaderPath) {
            return {
              html,
              tags: [
                {
                  tag: 'script',
                  attrs: { type: 'module', crossorigin: '', src: loaderPath },
                  injectTo: 'head-prepend',
                },
              ],
            };
          }
          return html;
        },
      },
    },
  ],
  resolve: {
    alias: {
      '@domain': `${import.meta.dirname}/src/domain`,
      '@usecase': `${import.meta.dirname}/src/usecase`,
      '@infra': `${import.meta.dirname}/src/infrastructure`,
      '@presentation': `${import.meta.dirname}/src/presentation`,
      '@workers': `${import.meta.dirname}/src/workers`,
    },
  },
  server: {
    // Flag 2: Vite dev proxy → Go backend at localhost:8080.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: ['es2020', 'safari15.4', 'ios15.4', 'chrome90', 'edge90', 'firefox90'],
    rollupOptions: {
      input: {
        main: `${import.meta.dirname}/index.html`,
        deviceCheck: `${import.meta.dirname}/device-check.html`,
        deviceCheckLoader: `${import.meta.dirname}/src/device-check-loader.ts`,
      },
    },
  },
  define: {
    __BUILD_TIMESTAMP__: JSON.stringify(new Date().toISOString()),
    'import.meta.env.VITE_E2E': JSON.stringify(process.env.VITE_E2E === 'true' ? 'true' : 'false'),
  },
});
