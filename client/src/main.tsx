import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Get base URL from environment variables or default to /repliNostr/
const baseUrl = '/repliNostr/';

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

      // Handle asset path rewrites through service worker
      registration.addEventListener('activate', () => {
        console.log('[SW] Service worker activated - handling asset paths');
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
console.log('[Debug] Environment:', {
  baseUrl,
  env: window.__ENV,
  currentUrl: window.location.href,
  origin: window.location.origin,
  pathname: window.location.pathname
});

createRoot(document.getElementById("root")!).render(<App />);