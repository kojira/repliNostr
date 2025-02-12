import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Post, User } from "@shared/schema";
import { useToast } from "./use-toast";
import { SimplePool, getPublicKey, getEventHash, nip19 } from 'nostr-tools';
import * as secp from '@noble/secp256k1';
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

      // Create a new pool for relays with debug options
      const pool = new SimplePool({
        getTimeout: 10000,  // 10 seconds timeout
        eoseTimeout: 5000,  // 5 seconds timeout for end of stored events
      });

      // Filter and get write-enabled relay URLs
      const relayUrls = user.relays
        .filter(relay => relay.write)
        .map(relay => relay.url);

      console.log("Attempting to connect to relays:", relayUrls);

      try {
        // Connect to relays first
        const relayConnections = await Promise.allSettled(
          relayUrls.map(async (url) => {
            console.log(`Connecting to relay: ${url}`);
            try {
              const relay = await pool.ensureRelay(url);
              console.log(`Successfully connected to relay: ${url}`);
              return relay;
            } catch (error) {
              console.error(`Failed to connect to relay ${url}:`, error);
              throw error;
            }
          })
        );

        // Check connection results
        const connectedRelays = relayConnections
          .filter((result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled')
          .map(result => result.value);

        console.log(`Successfully connected to ${connectedRelays.length} relays:`, 
          connectedRelays.map(relay => relay.url));

        if (connectedRelays.length === 0) {
          throw new Error("Failed to connect to any relays");
        }

        // Convert private key to proper format and get public key
        const privateKeyBytes = hexToBytes(user.privateKey);
        const pubkeyHex = getPublicKey(user.privateKey);
        console.log("Private key (hex):", user.privateKey);
        console.log("Public key (hex):", pubkeyHex);

        // Create the Nostr event
        const event = {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: content,
          pubkey: pubkeyHex
        };

        console.log("Created unsigned event:", JSON.stringify(event, null, 2));

        // Calculate the event hash (id)
        const id = getEventHash(event);
        console.log("Event hash generated:", id);

        // Sign the event using schnorr signature
        const signature = await secp.schnorr.sign(hexToBytes(id), privateKeyBytes);
        const signatureHex = bytesToHex(signature);

        // Create the complete signed event
        const signedEvent = {
          ...event,
          id,
          sig: signatureHex
        };

        console.log("Signed event:", JSON.stringify(signedEvent, null, 2));

        // Publish to connected relays
        const activeRelayUrls = connectedRelays.map(relay => relay.url);
        console.log("Publishing to relays:", activeRelayUrls);

        // Publish to each relay individually and log results
        const publishPromises = activeRelayUrls.map(async (url) => {
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
          Promise.any(publishPromises).then(result => {
            console.log("Successfully published to at least one relay:", result);
            return result;
          }),
          timeout
        ]);

        console.log("Final publish results:", results);

        // Return the created post
        return post;
      } catch (error) {
        console.error("Failed to publish to Nostr relays:", error);
        throw new Error(error instanceof Error ? error.message : "Failed to publish to Nostr relays");
      } finally {
        pool.close(relayUrls);
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

  return {
    posts: postsQuery.data || [],
    isLoadingPosts: postsQuery.isLoading,
    createPost: createPostMutation.mutate,
    isCreatingPost: createPostMutation.isPending,
  };
}