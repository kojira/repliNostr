import { pgTable, text, serial, integer, boolean, json } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  following: text("following").array().default([]).notNull(),
  relays: json("relays").$type<{
    url: string;
    read: boolean;
    write: boolean;
  }[]>().default([]).notNull()
});

export const posts = pgTable("posts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull(),
  metadata: json("metadata")
});

// Add more validation rules
export const insertUserSchema = createInsertSchema(users, {
  username: z.string().min(3, "Username must be at least 3 characters"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  publicKey: z.string(),
  privateKey: z.string(),
  relays: z.array(z.object({
    url: z.string().url("Invalid relay URL"),
    read: z.boolean(),
    write: z.boolean()
  })).default([])
}).pick({
  username: true,
  password: true,
  publicKey: true,
  privateKey: true,
  relays: true
});

export const insertPostSchema = createInsertSchema(posts).pick({
  content: true,
  metadata: true
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type Post = typeof posts.$inferSelect;

// Relay configuration schema
export const relaySchema = z.object({
  url: z.string().url("Invalid relay URL"),
  read: z.boolean(),
  write: z.boolean()
});

export type Relay = z.infer<typeof relaySchema>;