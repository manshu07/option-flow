/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
// @ts-expect-error Local ESM plugin is intentionally authored in JavaScript.
import widgetScope from './scripts/postcss-widget-scope.mjs';
// @ts-expect-error Local ESM plugin is intentionally authored in JavaScript.
import bucketSelectors from './scripts/postcss-bucket-selectors.mjs';

export default defineConfig(({ mode }) => {
  const gammaEnv = loadEnv(mode, process.cwd(), 'GAMMA_');
  const gammaSymbols = process.env.GAMMA_SYMBOLS ?? gammaEnv.GAMMA_SYMBOLS ?? 'NIFTY,BANKNIFTY';
  const gammaRiskFree = process.env.GAMMA_RISK_FREE ?? gammaEnv.GAMMA_RISK_FREE ?? '0.065';
  return {
    define: {
      __UI_TOOL_ONLY__: JSON.stringify('market-flow'),
      __GAMMA_SYMBOLS__: JSON.stringify(gammaSymbols),
      __GAMMA_RISK_FREE__: JSON.stringify(gammaRiskFree),
    },
    plugins: [react()],
    css: { postcss: { plugins: [widgetScope(), bucketSelectors()] } },
    resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
    server: {
      host: '127.0.0.1',
      port: 5195,
      // The data is the API's (server/index.mjs, `npm run api`); `npm run dev` starts both.
      proxy: { '/api': `http://127.0.0.1:${process.env.PORT || 8787}` },
    },
    test: {
      globals: true,
      environment: 'jsdom',
      include: ['src/**/*.{test,spec}.{ts,tsx}', 'server/**/*.test.ts'],
      environmentOptions: { jsdom: { url: 'http://localhost/' } },
      setupFiles: './src/setupTests.ts',
      testTimeout: 30000,
      hookTimeout: 30000,
    },
  };
});
