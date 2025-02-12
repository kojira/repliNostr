import { users, posts, type User, type InsertUser, type Relay, type Post } from "@shared/schema";
import { db } from "./db";
import { eq, desc } from "drizzle-orm";
import createMemoryStore from "memorystore";
import session from "express-session";
import connectPg from "connect-pg-simple";
import { pool } from "./db";

const PostgresSessionStore = connectPg(session);

export interface IStorage {
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUserProfile(userId: number, profile: { name?: string; about?: string; picture?: string }): Promise<boolean>;
  updateUserRelays(userId: number, relays: Relay[]): Promise<boolean>;
  getPosts(): Promise<Post[]>;
  createPost(content: string, userId: number, nostrEvent: { id: string; pubkey: string; sig: string; metadata?: any }): Promise<Post>;
  cacheNostrEvent(userId: number, event: { id: string; pubkey: string; content: string; sig: string; tags?: string[][]; relays?: string[] }): Promise<Post>;
  getPostByNostrId(eventId: string): Promise<Post | undefined>;
  sessionStore: session.Store;
}

export class DatabaseStorage implements IStorage {
  sessionStore: session.Store;

  constructor() {
    this.sessionStore = new PostgresSessionStore({
      pool,
      tableName: 'session'
    });
  }

  async getUser(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.username, username));
    return user;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values({ ...insertUser, following: [], relays: [] })
      .returning();
    return user;
  }

  async updateUserProfile(userId: number, profile: { name?: string; about?: string; picture?: string }): Promise<boolean> {
    const [user] = await db
      .update(users)
      .set(profile)
      .where(eq(users.id, userId))
      .returning();
    return !!user;
  }

  async updateUserRelays(userId: number, relays: Relay[]): Promise<boolean> {
    const [user] = await db
      .update(users)
      .set({ relays })
      .where(eq(users.id, userId))
      .returning();
    return !!user;
  }

  async getPosts(): Promise<Post[]> {
    return await db
      .select()
      .from(posts)
      .orderBy(desc(posts.createdAt));
  }

  async createPost(content: string, userId: number, nostrEvent: { id: string; pubkey: string; sig: string; metadata?: any }): Promise<Post> {
    const [post] = await db
      .insert(posts)
      .values({
        content,
        userId,
        createdAt: new Date().toISOString(),
        nostrEventId: nostrEvent.id,
        pubkey: nostrEvent.pubkey,
        signature: nostrEvent.sig,
        metadata: nostrEvent.metadata || {}
      })
      .returning();
    return post;
  }

  async cacheNostrEvent(userId: number, event: { id: string; pubkey: string; content: string; sig: string; tags?: string[][]; relays?: string[] }): Promise<Post> {
    // Check if event already exists
    const existing = await this.getPostByNostrId(event.id);
    if (existing) return existing;

    // Cache new event
    const [post] = await db
      .insert(posts)
      .values({
        content: event.content,
        userId,
        createdAt: new Date().toISOString(),
        nostrEventId: event.id,
        pubkey: event.pubkey,
        signature: event.sig,
        metadata: {
          tags: event.tags || [],
          relays: event.relays || []
        }
      })
      .returning();
    return post;
  }

  async getPostByNostrId(eventId: string): Promise<Post | undefined> {
    const [post] = await db
      .select()
      .from(posts)
      .where(eq(posts.nostrEventId, eventId));
    return post;
  }
}

export const storage = new DatabaseStorage();