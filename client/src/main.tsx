import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Register service worker for PWA support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/repliNostr/service-worker.js', {
      scope: '/repliNostr/'
    }).then(registration => {
      console.log('SW registered:', registration);
    }).catch(error => {
      console.log('SW registration failed:', error);
    });
  });
}

// Initialize base URL for assets
const baseUrl = import.meta.env.VITE_BASE_URL || '/repliNostr/';
if (window.__ENV) {
  window.__ENV.BASE_URL = baseUrl;
  window.__ENV.ASSET_URL = `${baseUrl}assets/`;
}

createRoot(document.getElementById("root")!).render(<App />);