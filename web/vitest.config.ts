import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
  resolve: {
    alias: {
      '@domain': `${import.meta.dirname}/src/domain`,
      '@usecase': `${import.meta.dirname}/src/usecase`,
      '@infra': `${import.meta.dirname}/src/infrastructure`,
      '@presentation': `${import.meta.dirname}/src/presentation`,
      '@workers': `${import.meta.dirname}/src/workers`,
    },
  },
});
