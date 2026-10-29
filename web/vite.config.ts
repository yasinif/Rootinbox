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
        globIgnores: ['**/crypto.worker*'],
      },
      devOptions: {
        enabled: false, // SW disabled in dev; use npm run build to test.
      },
    }),
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
  },
  define: {
    __BUILD_TIMESTAMP__: JSON.stringify(new Date().toISOString()),
    'import.meta.env.VITE_E2E': JSON.stringify(process.env.VITE_E2E === 'true' ? 'true' : 'false'),
  },
});
