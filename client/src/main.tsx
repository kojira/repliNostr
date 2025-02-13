import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Register service worker for PWA support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/repliNostr/service-worker.js', {
      scope: '/repliNostr/'
    }).then(registration => {
      console.log('[SW] Registration successful:', registration);
    }).catch(error => {
      console.log('[SW] Registration failed:', error);
    });
  });
}

// Get base URL from environment variables
const baseUrl = '/repliNostr/';
if (window.__ENV) {
  window.__ENV.BASE_URL = baseUrl;
  window.__ENV.ASSET_URL = `${baseUrl}assets/`;
}

// Debug logging
console.log('[Debug] Environment:', {
  baseUrl,
  env: window.__ENV,
  currentUrl: window.location.href
});

createRoot(document.getElementById("root")!).render(<App />);