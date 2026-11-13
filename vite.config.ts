import { defineConfig } from 'vite';

// GitHub Pages（https://<user>.github.io/mips-visualizer/）でも、ローカルでも動くように相対パスにする
export default defineConfig({
  base: './',
  build: { outDir: 'dist' },
});
