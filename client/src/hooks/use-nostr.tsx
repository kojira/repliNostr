import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Post, User } from "@shared/schema";
import { useToast } from "./use-toast";
import { SimplePool, getPublicKey, getEventHash, finalizeEvent } from 'nostr-tools';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { useEffect, useRef } from "react";

export function useNostr() {
  const { toast } = useToast();
  const poolRef = useRef<SimplePool | null>(null);

  // Initialize pool on mount
  useEffect(() => {
    poolRef.current = new SimplePool();

    return () => {
      if (poolRef.current) {
        poolRef.current.close();
      }
    };
  }, []);

  const postsQuery = useQuery<Post[]>({
    queryKey: ["/api/posts"],
    queryFn: async () => {
      // Get the current user and their relay settings
      const userRes = await apiRequest("GET", "/api/user");
      const user: User = await userRes.json();

      if (!poolRef.current) {
        throw new Error("Relay pool not initialized");
      }

      // Get read-enabled relay URLs
      const readRelays = user.relays
        .filter(relay => relay.read)
        .map(relay => relay.url);

      if (readRelays.length === 0) {
        throw new Error("No read-enabled relays configured");
      }

      console.log("Fetching events from relays:", readRelays);

      try {
        // Fetch recent events from relays using queryEvents
        const sub = poolRef.current.sub(readRelays, [{
          kinds: [1], // テキスト投稿
          limit: 100,
        }]);

        const events: any[] = [];
        await new Promise<void>((resolve, reject) => {
          sub.on('event', (event: any) => {
            events.push(event);
          });

          // Set a timeout to close the subscription after 3 seconds
          setTimeout(() => {
            sub.unsub();
            resolve();
          }, 3000);

          sub.on('eose', () => {
            sub.unsub();
            resolve();
          });
        });

        console.log("Received events:", events);

        // Cache events in the database
        const cachePromises = events.map(async (event) => {
          try {
            const res = await apiRequest("POST", "/api/posts/cache", {
              id: event.id,
              pubkey: event.pubkey,
              content: event.content,
              sig: event.sig,
              tags: event.tags,
              relays: readRelays
            });
            return await res.json();
          } catch (error) {
            console.error("Failed to cache event:", error);
            return null;
          }
        });

        const cachedPosts = await Promise.all(cachePromises);
        return cachedPosts.filter((post): post is Post => post !== null);
      } catch (error) {
        console.error("Failed to fetch events from relays:", error);
        // If relay fetch fails, fall back to cached posts
        const res = await apiRequest("GET", "/api/posts");
        return res.json();
      }
    },
    staleTime: 30000, // 30 seconds
  });

  const createPostMutation = useMutation({
    mutationFn: async (content: string) => {
      // Get the current user
      const userRes = await apiRequest("GET", "/api/user");
      const user: User = await userRes.json();

      console.log("Creating Nostr event for user:", user.username);
      console.log("User's relays:", JSON.stringify(user.relays, null, 2));

      try {
        // Convert hex private key to Uint8Array
        const privateKeyBytes = hexToBytes(user.privateKey);
        console.log("Private key bytes:", privateKeyBytes);

        // Create the unsigned event
        const unsignedEvent = {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: content,
          pubkey: getPublicKey(privateKeyBytes)
        };

        console.log("Created unsigned event:", JSON.stringify(unsignedEvent, null, 2));

        try {
          // Finalize and sign the event using nostr-tools
          console.log("Attempting to finalize and sign event...");
          const signedEvent = finalizeEvent(unsignedEvent, privateKeyBytes);
          console.log("Event signed successfully");
          console.log("Complete signed event:", JSON.stringify(signedEvent, null, 2));

          if (!poolRef.current) {
            throw new Error("Relay pool not initialized");
          }

          // Filter and get write-enabled relay URLs
          const writeRelays = user.relays
            .filter(relay => relay.write)
            .map(relay => relay.url);

          if (writeRelays.length === 0) {
            throw new Error("No write-enabled relays configured");
          }

          console.log("Publishing to relays:", writeRelays);

          // Publish to each relay individually and log results
          const publishPromises = writeRelays.map(async (url) => {
            try {
              console.log(`Attempting to publish to relay: ${url}`);
              const result = await poolRef.current!.publish([url], signedEvent);
              console.log(`Publish result for ${url}:`, result);
              return result;
            } catch (error) {
              console.error(`Failed to publish to relay ${url}:`, error);
              throw error;
            }
          });

          // Wait for at least one successful publish with timeout
          const timeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Publish timeout")), 5000)
          );

          const results = await Promise.race([
            Promise.any(publishPromises),
            timeout
          ]);

          console.log("Successfully published to relays:", results);

          // Cache the event in our database
          const cacheRes = await apiRequest("POST", "/api/posts/cache", {
            id: signedEvent.id,
            pubkey: signedEvent.pubkey,
            content: signedEvent.content,
            sig: signedEvent.sig,
            tags: signedEvent.tags,
            relays: writeRelays
          });

          return await cacheRes.json();

        } catch (error) {
          console.error("Failed to sign event:", error);
          throw new Error(`Failed to sign event: ${error instanceof Error ? error.message : String(error)}`);
        }
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

        // Convert hex private key to Uint8Array
        const privateKeyBytes = hexToBytes(user.privateKey);

        // Create the unsigned event for kind 0 (metadata)
        const unsignedEvent = {
          kind: 0,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content,
          pubkey: getPublicKey(privateKeyBytes)
        };

        console.log("Created unsigned metadata event:", JSON.stringify(unsignedEvent, null, 2));

        // Sign the event
        const signedEvent = finalizeEvent(unsignedEvent, privateKeyBytes);
        console.log("Metadata event signed successfully");

        if (!poolRef.current) {
          throw new Error("Relay pool not initialized");
        }

        // Get write-enabled relays
        const writeRelays = user.relays
          .filter(relay => relay.write)
          .map(relay => relay.url);

        if (writeRelays.length === 0) {
          throw new Error("No write-enabled relays configured");
        }

        // Connect and publish to relays
        const publishPromises = writeRelays.map(async (url) => {
          try {
            console.log(`Attempting to publish metadata to relay: ${url}`);
            const result = await poolRef.current!.publish([url], signedEvent);
            console.log(`Metadata publish result for ${url}:`, result);
            return result;
          } catch (error) {
            console.error(`Failed to publish metadata to relay ${url}:`, error);
            throw error;
          }
        });

        // Wait for at least one successful publish with timeout
        const timeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Publish timeout")), 5000)
        );

        const results = await Promise.race([
          Promise.any(publishPromises),
          timeout
        ]);

        console.log("Profile metadata published successfully:", results);

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
    posts: postsQuery.data || [],
    isLoadingPosts: postsQuery.isLoading,
    createPost: createPostMutation.mutate,
    isCreatingPost: createPostMutation.isPending,
    updateProfile: updateProfileMutation.mutate,
    isUpdatingProfile: updateProfileMutation.isPending,
  };
}