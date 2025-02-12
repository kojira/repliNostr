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

      // Create a new pool for relays
      const pool = new SimplePool();

      // Send to all configured relays
      const relayUrls = user.relays
        .filter(relay => relay.write)
        .map(relay => relay.url);

      try {
        await pool.publish(relayUrls, signedEvent);
      } catch (error) {
        console.error('Failed to publish to relays:', error);
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