import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

/** recharts and everything it pulls in, which nothing else in the app uses. */
const CHART_PACKAGES = new RegExp(
  '[\\\\/]node_modules[\\\\/](' +
  [
    'recharts', 'victory-vendor', 'd3-[a-z-]+', 'internmap', 'decimal\\.js-light',
    'eventemitter3', 'es-toolkit', 'immer', 'reselect', 'redux', 'redux-thunk',
    '@reduxjs[\\\\/]toolkit', 'react-redux', 'use-sync-external-store', 'tiny-invariant', 'clsx',
  ].join('|') +
  ')[\\\\/]',
);

export default defineConfig(() => {
  return {
    // The multi-app site serves this under /society/; standalone it serves at /.
    base: process.env.PUBLIC_BASE_PATH || '/',
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        output: {
          // Vendor code in its own chunks, so an app change does not bust the
          // cache for React, and the charting library — most of the weight —
          // stays in the chunk only the dashboards load (see Charts.tsx).
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return undefined;
            if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
            if (CHART_PACKAGES.test(id)) return 'charts';
            return undefined;
          },
        },
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 3600,
      host: '0.0.0.0',
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
