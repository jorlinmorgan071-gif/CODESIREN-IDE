import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [inspectAttr(), react()],
  server: {
    port: 3000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    // Phase 5 — chunk size warning threshold raised because we now use
    // manualChunks to split vendor code. The main app chunk should be well
    // under 500 KB after splitting; vendor chunks may exceed it intentionally.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks: {
          // React core — small, stable, shared across all routes
          'react-vendor': ['react', 'react-dom', 'react-router'],
          // Radix UI primitives — large, shared across all UI components
          'radix-vendor': [
            '@radix-ui/react-dialog',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-popover',
            '@radix-ui/react-tooltip',
            '@radix-ui/react-tabs',
            '@radix-ui/react-select',
            '@radix-ui/react-accordion',
            '@radix-ui/react-scroll-area',
            '@radix-ui/react-separator',
            '@radix-ui/react-slot',
            '@radix-ui/react-switch',
            '@radix-ui/react-checkbox',
            '@radix-ui/react-label',
            '@radix-ui/react-progress',
            '@radix-ui/react-avatar',
            '@radix-ui/react-context-menu',
            '@radix-ui/react-hover-card',
            '@radix-ui/react-menubar',
            '@radix-ui/react-navigation-menu',
            '@radix-ui/react-radio-group',
            '@radix-ui/react-slider',
            '@radix-ui/react-toggle',
            '@radix-ui/react-toggle-group',
            '@radix-ui/react-alert-dialog',
            '@radix-ui/react-aspect-ratio',
            '@radix-ui/react-collapsible',
          ],
          // Monaco editor — huge, only used in CodeEditor (loaded on demand anyway)
          'monaco-vendor': ['@monaco-editor/react'],
          // xterm — only used in Terminal
          'xterm-vendor': ['@xterm/xterm', '@xterm/addon-fit', 'xterm-addon-fit'],
          // Charts — only used in dashboard
          'charts-vendor': ['recharts'],
          // Three.js — only used in Brain Visualizer
          'three-vendor': ['three', '@react-three/fiber', '@react-three/drei'],
          // Form libraries
          'form-vendor': ['react-hook-form', '@hookform/resolvers', 'zod'],
          // Animation — standardized on `motion` (not framer-motion) per Section 0
          'animation-vendor': ['motion'],
          // Date utilities
          'date-vendor': ['date-fns', 'react-day-picker'],
          // Carousel
          'carousel-vendor': ['embla-carousel-react'],
          // Drawer/sheet
          'drawer-vendor': ['vaul'],
          // Misc UI
          'misc-vendor': ['cmdk', 'input-otp', 'next-themes', 'sonner', 'class-variance-authority', 'clsx', 'tailwind-merge', 'react-tooltip'],
        },
      },
    },
  },
});
