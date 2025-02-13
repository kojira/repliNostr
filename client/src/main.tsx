import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Get base URL from environment variables or default to /repliNostr/
const baseUrl = '/repliNostr/';

// Debug environment variables
console.log('[Debug] Environment Variables:', {
  VITE_BASE_URL: import.meta.env.VITE_BASE_URL,
  VITE_ASSET_URL: import.meta.env.VITE_ASSET_URL,
  VITE_PUBLIC_PATH: import.meta.env.VITE_PUBLIC_PATH,
  MODE: import.meta.env.MODE,
  DEV: import.meta.env.DEV,
  PROD: import.meta.env.PROD
});

// Register service worker for PWA support and asset path handling
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const swUrl = `${baseUrl}service-worker.js`;
      console.log('[SW] Registering service worker at:', swUrl);
      const registration = await navigator.serviceWorker.register(swUrl, {
        scope: baseUrl
      });
      console.log('[SW] Registration successful:', registration);

      // Check if service worker is active
      if (registration.active) {
        console.log('[SW] Service worker is active');
      }

      // Debug asset paths
      console.log('[Debug] Asset Paths:', {
        baseUrl,
        currentScript: document.currentScript?.getAttribute('src'),
        stylesheets: Array.from(document.styleSheets).map(sheet => sheet.href),
        scripts: Array.from(document.scripts).map(script => script.src)
      });

    } catch (error) {
      console.error('[SW] Registration failed:', error);
    }
  });
}

// Set environment variables
if (!window.__ENV) {
  window.__ENV = {};
}
window.__ENV.BASE_URL = baseUrl;
window.__ENV.ASSET_URL = `${baseUrl}assets/`;

// Debug logging
console.log('[Debug] Final Environment:', {
  baseUrl,
  env: window.__ENV,
  currentUrl: window.location.href,
  origin: window.location.origin,
  pathname: window.location.pathname
});

createRoot(document.getElementById("root")!).render(<App />);