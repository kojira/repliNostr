import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";

const app = express();

// Basic middleware setup
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Debug logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;

  // Capture the response body for logging
  const originalJson = res.json;
  let responseBody: any;
  res.json = function(body) {
    responseBody = body;
    return originalJson.call(this, body);
  };

  // Log after response is sent
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (path.startsWith('/api')) {
      log(`[DEBUG] ${req.method} ${path} ${res.statusCode} - ${duration}ms`);
      if (req.method !== 'GET') {
        log(`[DEBUG] Request Body: ${JSON.stringify(req.body)}`);
      }
      if (responseBody) {
        log(`[DEBUG] Response: ${JSON.stringify(responseBody)}`);
      }
    }
  });

  next();
});

// Error handling middleware
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  log(`[ERROR] ${err.stack}`);
  const status = (err as any).status || 500;
  const message = err.message || 'Internal Server Error';
  res.status(status).json({ error: message });
});

(async () => {
  try {
    const server = registerRoutes(app);

    if (app.get("env") === "development") {
      await setupVite(app, server);
    } else {
      serveStatic(app);
    }

    const PORT = 5000;
    server.listen(PORT, "0.0.0.0", () => {
      log(`[Server] Listening on port ${PORT}`);
    });
  } catch (error) {
    log(`[FATAL] Server failed to start: ${error}`);
    process.exit(1);
  }
})();