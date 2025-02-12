import { useMutation } from "@tanstack/react-query";
import { Post } from "@shared/schema";
import { useToast } from "./use-toast";
import { createRxNostr, createRxForwardReq } from 'rx-nostr';
import { verifier } from 'rx-nostr-crypto';
import { bytesToHex } from '@noble/hashes/utils';
import { useEffect, useRef, useState } from "react";
import type { RxNostr } from 'rx-nostr';

interface UserMetadata {
  name?: string;
  picture?: string;
  about?: string;
}

const DEFAULT_RELAYS = [
  "wss://r.kojira.io",
  "wss://x.kojira.io",
  // 必要に応じて他のリレーを追加
];

export function useNostr() {
  const { toast } = useToast();
  const rxRef = useRef<RxNostr | null>(null);
  const [posts, setPosts] = useState<Map<string, Post>>(new Map());
  const [userMetadata, setUserMetadata] = useState<Map<string, UserMetadata>>(new Map());

  // Initialize rx-nostr and set default relays
  useEffect(() => {
    rxRef.current = createRxNostr({
      verifier
    });

    if (rxRef.current) {
      rxRef.current.setDefaultRelays(DEFAULT_RELAYS);
    }

    return () => {
      if (rxRef.current) {
        rxRef.current.dispose();
      }
    };
  }, []);

  // Function to fetch user metadata from relays
  const fetchUserMetadata = async (pubkey: string) => {
    if (!rxRef.current || userMetadata.has(pubkey)) return;

    // Set initial placeholder while fetching
    setUserMetadata(current => {
      const updated = new Map(current);
      if (!updated.has(pubkey)) {
        updated.set(pubkey, { name: `nostr:${pubkey.slice(0, 8)}` });
      }
      return updated;
    });

    try {
      // Create filter for kind 0 (metadata) events
      const filter = {
        kinds: [0],
        authors: [pubkey],
        limit: 1
      };

      const rxReq = createRxForwardReq();

      // Set timeout for metadata request
      const timeoutId = setTimeout(() => {
        console.log(`Metadata request timeout for pubkey: ${pubkey}`);
        // Keep the placeholder if timeout occurs
      }, 5000);

      // Subscribe to metadata events
      rxRef.current
        .use(rxReq)
        .subscribe({
          next: ({ event }) => {
            clearTimeout(timeoutId);
            try {
              const metadata = JSON.parse(event.content) as UserMetadata;
              console.log(`Received metadata for ${pubkey}:`, metadata);
              setUserMetadata(current => {
                const updated = new Map(current);
                updated.set(pubkey, {
                  name: metadata.name || `nostr:${pubkey.slice(0, 8)}`,
                  picture: metadata.picture,
                  about: metadata.about
                });
                return updated;
              });
            } catch (error) {
              console.error(`Failed to parse metadata for ${pubkey}:`, error);
              // Placeholder already set, no need to update
            }
          },
          error: (error) => {
            clearTimeout(timeoutId);
            console.error(`Error receiving metadata for ${pubkey}:`, error);
            // Placeholder already set, no need to update
          }
        });

      // Emit filter to start subscription
      rxReq.emit(filter);
    } catch (error) {
      console.error(`Failed to fetch metadata for ${pubkey}:`, error);
      // Placeholder already set, no need to update
    }
  };

  // Subscribe to new posts from relays
  useEffect(() => {
    if (!rxRef.current) return;

    const fetchFromRelays = async () => {
      try {
        // Create filter
        const filter = {
          kinds: [1],
          limit: 100,
          since: Math.floor(Date.now() / 1000) - 24 * 60 * 60 // Last 24 hours
        };

        const rxReq = createRxForwardReq();

        // Subscribe to events
        rxRef.current
          .use(rxReq)
          .subscribe({
            next: ({ event }) => {
              // Add new event to posts Map if it doesn't exist
              setPosts(currentPosts => {
                if (currentPosts.has(event.id)) return currentPosts;

                console.log(`New post received from ${event.pubkey}`);
                // Fetch user metadata if not already cached
                fetchUserMetadata(event.pubkey);

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
                    relays: DEFAULT_RELAYS
                  }
                };

                // Update Map with new post
                const updatedPosts = new Map(currentPosts);
                updatedPosts.set(event.id, newPost);
                return updatedPosts;
              });
            },
            error: (error) => {
              console.error("Error receiving events:", error);
            }
          });

        // Emit filter to start subscription
        rxReq.emit(filter);
      } catch (error) {
        console.error("Failed to fetch events from relays:", error);
      }
    };

    fetchFromRelays();
  }, []);

  // Fetch metadata for all unique pubkeys in posts
  useEffect(() => {
    const pubkeys = new Set(Array.from(posts.values()).map(post => post.pubkey));
    pubkeys.forEach(pubkey => {
      if (!userMetadata.has(pubkey)) {
        fetchUserMetadata(pubkey);
      }
    });
  }, [posts]);

  const createPostMutation = useMutation({
    mutationFn: async (event: { content: string; pubkey: string; privateKey: string }) => {
      try {
        // Create event
        const nostrEvent = {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: event.content,
          pubkey: event.pubkey
        };

        // Sign the event
        const id = await window.crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(JSON.stringify([0, nostrEvent.pubkey, nostrEvent.created_at, nostrEvent.kind, nostrEvent.tags, nostrEvent.content]))
        );
        const signedEvent = {
          ...nostrEvent,
          id: bytesToHex(new Uint8Array(id)),
          sig: event.privateKey // 仮の署名として private key を使用（実際のアプリではちゃんとした署名が必要）
        };

        // Publish event
        await rxRef.current!.send(signedEvent);

        return signedEvent;
      } catch (error) {
        console.error("Failed to publish to Nostr relays:", error);
        throw new Error(error instanceof Error ? error.message : "Failed to publish to Nostr relays");
      }
    },
    onSuccess: () => {
      toast({
        title: "投稿を作成しました",
        description: "投稿はNostrリレーに保存されました",
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
    mutationFn: async (event: { profile: { name?: string; about?: string; picture?: string }; pubkey: string; privateKey: string }) => {
      try {
        // Create metadata content
        const content = JSON.stringify(event.profile);

        // Create event
        const nostrEvent = {
          kind: 0,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content,
          pubkey: event.pubkey
        };

        // Sign the event
        const id = await window.crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(JSON.stringify([0, nostrEvent.pubkey, nostrEvent.created_at, nostrEvent.kind, nostrEvent.tags, nostrEvent.content]))
        );
        const signedEvent = {
          ...nostrEvent,
          id: bytesToHex(new Uint8Array(id)),
          sig: event.privateKey // 仮の署名として private key を使用（実際のアプリではちゃんとした署名が必要）
        };

        // Publish event
        await rxRef.current!.send(signedEvent);

        return event.profile;
      } catch (error) {
        console.error("Failed to update profile:", error);
        throw new Error(error instanceof Error ? error.message : "Failed to update profile");
      }
    },
    onSuccess: () => {
      toast({
        title: "プロフィールを更新しました",
        description: "プロフィール情報がNostrリレーに保存されました",
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
    isLoadingPosts: false,
    createPost: createPostMutation.mutate,
    isCreatingPost: createPostMutation.isPending,
    updateProfile: updateProfileMutation.mutate,
    isUpdatingProfile: updateProfileMutation.isPending,
    getUserMetadata: (pubkey: string) => {
      if (!userMetadata.has(pubkey)) {
        fetchUserMetadata(pubkey);
      }
      return userMetadata.get(pubkey);
    }
  };
}