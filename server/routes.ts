import type { Express } from "express";
import { createServer, type Server } from "http";
import { setupAuth } from "./auth";
import { storage } from "./storage";
import { insertPostSchema, relaySchema } from "@shared/schema";
import { log } from "./vite";
import { z } from "zod";

// プロフィール更新のためのスキーマ
const updateProfileSchema = z.object({
  name: z.string().optional(),
  about: z.string().optional(),
  picture: z.string().url("Invalid profile picture URL").optional(),
});

export function registerRoutes(app: Express): Server {
  // Add debug middleware
  app.use((req, res, next) => {
    console.log(`[DEBUG] ${req.method} ${req.path}`);
    next();
  });

  setupAuth(app);

  // Profile update endpoint
  app.post("/api/profile", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    try {
      log(`[Profile] Updating profile for user: ${req.user.username}`);
      const profile = updateProfileSchema.parse(req.body);

      const updated = await storage.updateUserProfile(req.user.id, profile);
      if (!updated) {
        log(`[Profile] Failed to update profile for user: ${req.user.username}`);
        return res.status(404).json({ error: "User not found" });
      }

      log(`[Profile] Successfully updated profile for user: ${req.user.username}`);
      res.json({ success: true, profile });
    } catch (error) {
      log(`[Profile] Error updating profile: ${error}`);
      res.status(400).json({ error: "Invalid profile data" });
    }
  });

  // Posts
  app.post("/api/posts", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    const validatedPost = insertPostSchema.parse(req.body);

    try {
      const post = await storage.createPost(validatedPost.content, req.user.id);
      res.json(post);
    } catch (error) {
      console.error('[Posts] Create post error:', error);
      res.status(500).json({ error: "Failed to create post" });
    }
  });

  app.get("/api/posts", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    try {
      const posts = await storage.getPosts();
      res.json(posts);
    } catch (error) {
      console.error('[Posts] Get posts error:', error);
      res.status(500).json({ error: "Failed to fetch posts" });
    }
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