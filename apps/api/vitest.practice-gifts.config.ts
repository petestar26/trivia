import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['src/gift-collection/practice-service.test.ts'],pool:'forks',minWorkers:1,maxWorkers:1,testTimeout:30000,hookTimeout:30000 } });
