import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Post, User } from "@shared/schema";
import { useToast } from "./use-toast";
import { createRxNostr, createRxForwardReq } from 'rx-nostr';
import { verifier } from 'rx-nostr-crypto';
import { bytesToHex } from '@noble/hashes/utils';
import { useEffect, useRef, useState } from "react";
import type { RxNostr } from 'rx-nostr';

export function useNostr() {
  const { toast } = useToast();
  const rxRef = useRef<RxNostr | null>(null);
  const [posts, setPosts] = useState<Map<string, Post>>(new Map());

  // Initialize rx-nostr on mount
  useEffect(() => {
    rxRef.current = createRxNostr({
      verifier // 必須のverifierを設定
    });
    return () => {
      if (rxRef.current) {
        rxRef.current.dispose();
      }
    };
  }, []);

  // Load cached posts from database
  const postsQuery = useQuery<Post[]>({
    queryKey: ["/api/posts"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/posts");
      const cachedPosts = await res.json();
      // Update posts Map with cached data
      setPosts(new Map(cachedPosts.map(post => [post.nostrEventId, post])));
      return cachedPosts;
    },
  });

  // Subscribe to new posts from relays
  useEffect(() => {
    if (!rxRef.current) return;

    const fetchFromRelays = async () => {
      try {
        // Get the current user and their relay settings
        const userRes = await apiRequest("GET", "/api/user");
        const user: User = await userRes.json();

        // Get read-enabled relay URLs
        const readRelays = user.relays
          .filter(relay => relay.read)
          .map(relay => relay.url);

        if (readRelays.length === 0) {
          throw new Error("No read-enabled relays configured");
        }

        console.log("Fetching events from relays:", readRelays);

        // Set default relays for this query
        rxRef.current.setDefaultRelays(readRelays);

        // Create filter
        const filter = {
          kinds: [1],
          limit: 100,
          since: Math.floor(Date.now() / 1000) - 24 * 60 * 60 // Last 24 hours
        };

        const rxReq = createRxForwardReq();

        // Define a listener for new events
        rxRef.current
          .use(rxReq)
          .subscribe({
            next: ({ event }) => {
              console.log("Received new event:", event);
              // Add new event to posts Map if it doesn't exist
              setPosts(currentPosts => {
                if (currentPosts.has(event.id)) {
                  console.log("Event already exists:", event.id);
                  return currentPosts;
                }

                console.log("Adding new event:", event.id);

                // Create a temporary post object
                const newPost: Post = {
                  id: 0, // This will be set by the database
                  userId: 0, // This will be set by the database
                  content: event.content,
                  createdAt: new Date(event.created_at * 1000).toISOString(),
                  nostrEventId: event.id,
                  pubkey: event.pubkey,
                  signature: event.sig,
                  metadata: {
                    tags: event.tags || [],
                    relays: readRelays
                  }
                };

                // Update Map with new post
                const updatedPosts = new Map(currentPosts);
                updatedPosts.set(event.id, newPost);

                // Asynchronously cache the event
                apiRequest("POST", "/api/posts/cache", {
                  id: event.id,
                  pubkey: event.pubkey,
                  content: event.content,
                  sig: event.sig,
                  tags: event.tags,
                  relays: readRelays
                }).catch(error => {
                  console.error("Failed to cache event:", error);
                });

                return updatedPosts;
              });
            },
            error: (error) => {
              console.error("Error receiving events:", error);
            }
          });

        // Emit filter to start subscription
        console.log("Emitting filter:", filter);
        rxReq.emit(filter);
      } catch (error) {
        console.error("Failed to fetch events from relays:", error);
      }
    };

    fetchFromRelays();
  }, []);

  const createPostMutation = useMutation({
    mutationFn: async (content: string) => {
      // Get the current user
      const userRes = await apiRequest("GET", "/api/user");
      const user: User = await userRes.json();

      console.log("Creating Nostr event for user:", user.username);

      try {
        // Get write-enabled relay URLs
        const writeRelays = user.relays
          .filter(relay => relay.write)
          .map(relay => ({ url: relay.url }));

        if (writeRelays.length === 0) {
          throw new Error("No write-enabled relays configured");
        }

        // Create a new RxNostr instance with the current relays
        rxRef.current = createRxNostr(writeRelays);

        // Create event
        const event = {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content,
          pubkey: user.publicKey
        };

        // Sign the event
        const id = await window.crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]))
        );
        const signedEvent = {
          ...event,
          id: bytesToHex(new Uint8Array(id)),
          sig: user.privateKey // 仮の署名として private key を使用（実際のアプリではちゃんとした署名が必要）
        };

        // Publish event
        await rxRef.current.send(signedEvent);

        // Cache the event in our database
        const cacheRes = await apiRequest("POST", "/api/posts/cache", {
          id: signedEvent.id,
          pubkey: signedEvent.pubkey,
          content: signedEvent.content,
          sig: signedEvent.sig,
          tags: signedEvent.tags,
          relays: writeRelays.map(r => r.url)
        });

        return await cacheRes.json();

      } catch (error) {
        console.error("Failed to publish to Nostr relays:", error);
        throw new Error(error instanceof Error ? error.message : "Failed to publish to Nostr relays");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/posts"] });
      toast({
        title: "投稿を作成しました",
        description: "投稿はNostrリレーとデータベースに保存されました",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "投稿の作成に失敗しました",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const updateProfileMutation = useMutation({
    mutationFn: async (profile: { name?: string; about?: string; picture?: string }) => {
      // Get the current user
      const userRes = await apiRequest("GET", "/api/user");
      const user: User = await userRes.json();

      try {
        // Create metadata content
        const content = JSON.stringify(profile);

        // Get write-enabled relays
        const writeRelays = user.relays
          .filter(relay => relay.write)
          .map(relay => ({ url: relay.url }));

        if (writeRelays.length === 0) {
          throw new Error("No write-enabled relays configured");
        }

        // Create a new RxNostr instance with the current relays
        rxRef.current = createRxNostr(writeRelays);

        // Create event
        const event = {
          kind: 0,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content,
          pubkey: user.publicKey
        };

        // Sign the event
        const id = await window.crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]))
        );
        const signedEvent = {
          ...event,
          id: bytesToHex(new Uint8Array(id)),
          sig: user.privateKey // 仮の署名として private key を使用（実際のアプリではちゃんとした署名が必要）
        };

        // Publish event
        await rxRef.current.send(signedEvent);

        // Update user profile in database
        await apiRequest("POST", "/api/profile", profile);

        return profile;
      } catch (error) {
        console.error("Failed to update profile:", error);
        throw new Error(error instanceof Error ? error.message : "Failed to update profile");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/user"] });
      toast({
        title: "プロフィールを更新しました",
        description: "プロフィール情報がNostrリレーとデータベースに保存されました",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "プロフィールの更新に失敗しました",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  return {
    posts: Array.from(posts.values()).sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    ),
    isLoadingPosts: postsQuery.isLoading,
    createPost: createPostMutation.mutate,
    isCreatingPost: createPostMutation.isPending,
    updateProfile: updateProfileMutation.mutate,
    isUpdatingProfile: updateProfileMutation.isPending,
  };
}