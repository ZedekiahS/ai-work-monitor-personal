import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({root:fileURLToPath(new URL('.',import.meta.url)),plugins:[react()],server:{host:'127.0.0.1',port:5173,proxy:{'/api':{target:'http://127.0.0.1:4318',changeOrigin:true}}},build:{outDir:'../dist/ui',emptyOutDir:true,sourcemap:false}});
