import { defineConfig } from 'vite';
export default defineConfig({ base: './', build: { target: 'safari17' }, worker: { format: 'es' } });
