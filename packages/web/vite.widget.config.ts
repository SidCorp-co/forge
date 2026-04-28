import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import { resolve } from 'path';

/** Inline CSS into the JS bundle by injecting a <style> tag at runtime. */
function inlineCssPlugin(): Plugin {
  return {
    name: 'inline-css',
    enforce: 'post',
    generateBundle(_opts, bundle) {
      let cssCode = '';
      const cssFiles: string[] = [];
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (fileName.endsWith('.css') && chunk.type === 'asset') {
          cssCode += chunk.source;
          cssFiles.push(fileName);
        }
      }
      // Remove CSS files from output
      for (const f of cssFiles) delete bundle[f];

      if (!cssCode) return;

      // Inject CSS into the JS entry
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk' && chunk.isEntry) {
          const escaped = cssCode.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
          chunk.code = `(function(){var s=document.createElement('style');s.textContent=\`${escaped}\`;document.head.appendChild(s)})();\n${chunk.code}`;
          break;
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), inlineCssPlugin()],
  css: {
    postcss: {
      plugins: [tailwindcss()],
    },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'process.env': '{}',
    'process': JSON.stringify({ env: { NODE_ENV: 'production' }, emit: null }),
  },
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/widget/index.tsx'),
      name: 'ForgeWidget',
      formats: ['iife'],
      fileName: () => 'forge-widget.js',
    },
    outDir: 'dist-widget',
    cssCodeSplit: false,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
