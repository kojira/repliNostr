import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Get base URL from environment or default
const baseUrl = import.meta.env.DEV ? '/' : '/repliNostr/';

// Debug environment variables
console.log('[Debug] Environment Variables:', {
  BASE_URL: baseUrl,
  MODE: import.meta.env.MODE,
  DEV: import.meta.env.DEV,
  PROD: import.meta.env.PROD
});

// Register service worker for PWA support and asset path handling
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      // Register service worker with the correct path
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

    } catch (error) {
      console.error('[SW] Registration failed:', error);
    }
  });
}

// Set environment variables
if (!window.__ENV) {
  window.__ENV = {
    BASE_URL: baseUrl,
    ASSET_URL: import.meta.env.DEV ? '/assets/' : `${baseUrl}assets/`
  };
}

// Debug logging
console.log('[Debug] Final Environment:', {
  baseUrl,
  env: window.__ENV,
  currentUrl: window.location.href,
  origin: window.location.origin,
  pathname: window.location.pathname
});

createRoot(document.getElementById("root")!).render(<App />);