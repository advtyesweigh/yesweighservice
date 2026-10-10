import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { sanoftShopsDevPlugin } from './scripts/viteSanoftShopsPlugin';

const require = createRequire(import.meta.url);
const projectRoot = dirname(fileURLToPath(import.meta.url));

/** Copy the pdf.js worker next to the app so API and worker cannot drift versions. */
function syncPdfjsWorker(): Plugin {
  const sync = () => {
    const workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.min.mjs');
    const destDir = join(projectRoot, 'public', 'pdfjs');
    mkdirSync(destDir, { recursive: true });
    copyFileSync(workerSrc, join(destDir, 'pdf.worker.min.mjs'));
  };
  return {
    name: 'sync-pdfjs-worker',
    buildStart: sync,
    configureServer: sync,
  };
}

export default defineConfig(({ mode }) => ({
  optimizeDeps: {
    // Keep pdf.js out of the prebundle so the API and worker resolve from the
    // same package copy. A stale dep cache was serving API 6.2.108 with worker 6.0.227.
    exclude: ['pdfjs-dist'],
  },
  worker: {
    format: 'es',
  },
  plugins: [
    syncPdfjsWorker(),
    sanoftShopsDevPlugin(loadEnv(mode, projectRoot, '')),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Register from main.tsx so the Android APK can skip the SW (avoids stale cache).
      injectRegister: false,
      includeAssets: [
        'logo.png',
        'icons/favicon-16.png',
        'icons/favicon-32.png',
        'icons/favicon-48.png',
        'icons/apple-touch-icon.png',
        'pdfjs/pdf.worker.min.mjs',
      ],
      manifest: {
        name: 'YesOne Platform',
        short_name: 'YesOne',
        description:
          'One platform, unlimited possibilities. Everything you need all in one place.',
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        orientation: 'portrait-primary',
        scope: '/',
        start_url: '/signup',
        categories: ['business', 'productivity'],
        icons: [
          {
            src: '/icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/icons/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Avoid verbose "No route found" logs in production SW.
        mode: 'production',
        // Main bundle can exceed the default 2 MiB Workbox precache limit
        // (currently ~4.2 MB after Delhivery/logistics growth).
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2,webmanifest}'],
        navigateFallback: '/index.html',
        navigateFallbackAllowlist: [
          /^\/$/,
          /^\/signup$/,
          /^\/dealer-login$/,
          /^\/login$/,
          /^\/oc$/,
          /^\/dealer(\/.*)?$/,
          /^\/dealer-staff(\/.*)?$/,
          /^\/staff(\/.*)?$/,
          /^\/super-admin(\/.*)?$/,
        ],
        navigateFallbackDenylist: [/^\/__/, /^\/firebase-messaging-sw\.js$/],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/asia-south1-yesweigh-service\.cloudfunctions\.net\/.*/i,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /^https:\/\/firestore\.googleapis\.com\/.*/i,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /^https:\/\/identitytoolkit\.googleapis\.com\/.*/i,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /^https:\/\/securetoken\.googleapis\.com\/.*/i,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /^https:\/\/firebasestorage\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'storage-images',
              expiration: {
                maxEntries: 500,
                maxAgeSeconds: 60 * 60 * 24 * 30,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/storage\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'storage-images-gcs',
              expiration: {
                maxEntries: 200,
                maxAgeSeconds: 60 * 60 * 24 * 30,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-stylesheets',
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 365,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              expiration: {
                maxEntries: 30,
                maxAgeSeconds: 60 * 60 * 24 * 365,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
}));
