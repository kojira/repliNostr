import type { Express } from "express";
import { createServer, type Server } from "http";
import { setupAuth } from "./auth";
import { storage } from "./storage";
import { insertPostSchema, relaySchema } from "@shared/schema";
import { log } from "./vite";

export function registerRoutes(app: Express): Server {
  // Add debug middleware
  app.use((req, res, next) => {
    console.log(`[DEBUG] ${req.method} ${req.path}`);
    next();
  });

  setupAuth(app);

  // Posts
  app.post("/api/posts", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    const validatedPost = insertPostSchema.parse(req.body);

    const post = {
      ...validatedPost,
      userId: req.user.id,
      createdAt: new Date().toISOString()
    };

    res.json(post);
  });

  app.get("/api/posts", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    // In a real implementation, this would fetch from relays
    res.json([]);
  });

  // Following
  app.post("/api/follow/:pubkey", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    const { pubkey } = req.params;

    const user = await storage.getUser(req.user.id);
    if (!user) return res.sendStatus(404);

    const following = [...(user.following || []), pubkey];
    // Update user following list
    res.json({ following });
  });

  // Relay settings
  app.post("/api/relays", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    try {
      log(`[Relays] Updating relays for user: ${req.user.username}`);
      const relays = req.body.relays.map((relay: unknown) => relaySchema.parse(relay));

      const updated = await storage.updateUserRelays(req.user.id, relays);
      if (!updated) {
        log(`[Relays] Failed to update relays for user: ${req.user.username}`);
        return res.status(404).json({ error: "User not found" });
      }

      log(`[Relays] Successfully updated relays for user: ${req.user.username}`);
      res.json({ relays });
    } catch (error) {
      log(`[Relays] Error updating relays: ${error}`);
      res.status(400).json({ error: "Invalid relay configuration" });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}