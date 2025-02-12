import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Post, User } from "@shared/schema";
import { useToast } from "./use-toast";
import * as nostr from "nostr-tools";

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

      // Create and sign the Nostr event
      const event = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: content,
        pubkey: user.publicKey
      };

      const signedEvent = await nostr.finishEvent(event, user.privateKey);

      // Send to all configured relays
      for (const relay of user.relays) {
        if (relay.write) {
          try {
            const relayConnection = nostr.relayInit(relay.url);
            await relayConnection.connect();
            await relayConnection.publish(signedEvent);
            await relayConnection.close();
          } catch (error) {
            console.error(`Failed to publish to relay ${relay.url}:`, error);
          }
        }
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

  const followUserMutation = useMutation({
    mutationFn: async (pubkey: string) => {
      const res = await apiRequest("POST", `/api/follow/${pubkey}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/user"] });
      toast({
        title: "Success",
        description: "You are now following this user",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to follow user",
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
    followUser: followUserMutation.mutate,
    isFollowingUser: followUserMutation.isPending,
  };
}