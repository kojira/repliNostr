import { pgTable, text, serial, integer, boolean, json } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  following: text("following").array()
});

export const posts = pgTable("posts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull(),
  metadata: json("metadata")
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
  publicKey: true,
  privateKey: true
});

export const insertPostSchema = createInsertSchema(posts).pick({
  content: true,
  metadata: true
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type Post = typeof posts.$inferSelect;
