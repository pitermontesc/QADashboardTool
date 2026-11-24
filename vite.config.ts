import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/client', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:8765' } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/desktop/**'],
      reporter: ['text-summary', 'html'],
      // A floor just under today's numbers (v1.14.1), so coverage cannot drop unnoticed. Raise it as tests are added.
      thresholds: { statements: 72, branches: 64, functions: 65, lines: 74 },
    },
  },
});
