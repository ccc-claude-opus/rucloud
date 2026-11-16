import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// build 輸出直接放到 public/（rucloud / wrangler 的靜態資產目錄）
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'public', emptyOutDir: true },
}));
