import { defineConfig } from 'vite';
export default defineConfig({ worker: { format: 'es' }, test: { include: ['test/**/*.test.js'] } });
