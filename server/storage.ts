import { posts, type Post } from "@shared/schema";
import { db } from "./db";
import { eq, desc } from "drizzle-orm";

export interface IStorage {
  getPosts(): Promise<Post[]>;
  createPost(content: string, userId: number, nostrEvent: { id: string; pubkey: string; sig: string; metadata?: any }): Promise<Post>;
  cacheNostrEvent(userId: number, event: { id: string; pubkey: string; content: string; sig: string; tags?: string[][]; relays?: string[] }): Promise<Post>;
  getPostByNostrId(eventId: string): Promise<Post | undefined>;
}

export class DatabaseStorage implements IStorage {
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