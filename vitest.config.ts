import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['web/src/**/*.test.{ts,tsx}'],
          setupFiles: ['web/src/test-setup.ts'],
        },
      },
    ],
  },
});
