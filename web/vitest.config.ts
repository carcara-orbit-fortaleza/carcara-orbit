import { defineConfig } from 'vitest/config'

// Testes só de lógica pura (sem DOM): ambiente node, sem plugins de React/Tailwind.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
