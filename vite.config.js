import { fileURLToPath, URL } from "node:url";
import dsv from "@rollup/plugin-dsv";

import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import vueDevTools from "vite-plugin-vue-devtools";
import { VitePWA } from "vite-plugin-pwa";

import AutoImport from 'unplugin-auto-import/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    vueDevTools(),
    dsv(),
    AutoImport({
      imports: [
        'vue',
        {
          'pinia': ['defineStore', 'storeToRefs', 'acceptHMRUpdate']
        }
      ]
    }),
    VitePWA({
      // Al publicar una versión nueva, el SW se actualiza solo en la próxima carga
      registerType: 'autoUpdate',
      // Sin iconos por ahora (camino A): el offline no los necesita, solo la "instalación"
      manifest: {
        name: 'Serpientes y Escaleras',
        short_name: 'Escaleras',
        description: 'Relevamiento de escaleras eléctricas del Metro de la CDMX',
        theme_color: '#1867C0',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        scope: '/',
      },
      workbox: {
        // Precachear todo el app shell, incluidas las fuentes de iconos (material-design-icons)
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2,ttf,eot}'],
        // Deep links (ej. /station/:id) recargados offline devuelven el index.html cacheado
        navigateFallback: '/index.html',
        // Vuetify/d3 generan chunks grandes; subir el límite para que sí se precacheen
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      // El SW real solo corre en build/preview. Para probar: npm run build && npm run preview
      devOptions: {
        enabled: false,
      },
    }),
  ],
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    port: 5174,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
