import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Post, User } from "@shared/schema";
import { useToast } from "./use-toast";
import { SimplePool, getPublicKey, getEventHash } from 'nostr-tools';
import * as secp256k1 from '@noble/secp256k1';
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

      // Create the Nostr event
      const event = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: content,
        pubkey: getPublicKey(user.privateKey)
      };

      // Calculate the event hash (id)
      const id = getEventHash(event);
      console.log("Event hash generated:", id);

      // Convert the event hash to bytes and sign it
      const eventHash = hexToBytes(id);
      const privateKeyBytes = hexToBytes(user.privateKey);
      const signature = await secp256k1.schnorr.sign(eventHash, privateKeyBytes);

      // Create the complete signed event
      const signedEvent = {
        ...event,
        id,
        sig: bytesToHex(signature)
      };

      console.log("Signed event:", signedEvent);

      // Create a new pool for relays
      const pool = new SimplePool();

      // Filter and get write-enabled relay URLs
      const relayUrls = user.relays
        .filter(relay => relay.write)
        .map(relay => relay.url);

      console.log("Connecting to relays:", relayUrls);

      try {
        // Connect to relays first
        const relayConnections = relayUrls.map(url => {
          console.log(`Attempting to connect to relay: ${url}`);
          return pool.ensureRelay(url);
        });

        const connectedRelays = await Promise.all(relayConnections);
        console.log("Connected relays:", connectedRelays.map(relay => relay.url));

        // Publish to all configured relays
        console.log("Publishing event to relays...");
        const pubs = pool.publish(relayUrls, signedEvent);

        // Wait for at least one successful publish with timeout
        const timeout = new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Publish timeout")), 5000)
        );

        const results = await Promise.race([
          Promise.any(pubs),
          timeout
        ]);

        console.log("Publish success:", results);
      } catch (error) {
        console.error("Failed to publish to relays:", error);
        throw new Error("Failed to publish to Nostr relays");
      } finally {
        pool.close(relayUrls);
      }

      return post;
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

  return {
    posts: postsQuery.data || [],
    isLoadingPosts: postsQuery.isLoading,
    createPost: createPostMutation.mutate,
    isCreatingPost: createPostMutation.isPending,
  };
}