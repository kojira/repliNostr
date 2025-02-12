import type { Express } from "express";
import { createServer, type Server } from "http";
import { setupAuth } from "./auth";
import { storage } from "./storage";
import { insertPostSchema } from "@shared/schema";

export function registerRoutes(app: Express): Server {
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

  const httpServer = createServer(app);
  return httpServer;
}
