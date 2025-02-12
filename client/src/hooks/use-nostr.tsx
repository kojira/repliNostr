import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Post, User } from "@shared/schema";
import { useToast } from "./use-toast";
import { SimplePool, getPublicKey, getEventHash, finalizeEvent } from 'nostr-tools';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

export function useNostr() {
  const { toast } = useToast();

  const postsQuery = useQuery<Post[]>({
    queryKey: ["/api/posts"],
    staleTime: 30000, // 30 seconds
  });

  const createPostMutation = useMutation({
    mutationFn: async (content: string) => {
      // First, create the post in our database
      const res = await apiRequest("POST", "/api/posts", { content });
      const post = await res.json();

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

          // Create a new pool for relays
          const pool = new SimplePool();

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
              const result = await pool.publish([url], signedEvent);
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
          return post;

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
        description: "投稿はデータベースとNostrリレーに保存されました",
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

        // Create a new pool for relays
        const pool = new SimplePool();

        // Get write-enabled relays
        const writeRelays = user.relays
          .filter(relay => relay.write)
          .map(relay => relay.url);

        if (writeRelays.length === 0) {
          throw new Error("No write-enabled relays configured");
        }

        // Connect and publish to relays
        const publishPromises = writeRelays.map(async (url) => {
          const relay = await pool.ensureRelay(url);
          return pool.publish([url], signedEvent);
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