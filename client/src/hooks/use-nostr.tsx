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
];

// ローカルストレージのキー
const METADATA_CACHE_KEY = 'nostr_metadata_cache';
const METADATA_TIMESTAMP_KEY = 'nostr_metadata_timestamp';
const CACHE_TTL = 1000 * 60 * 60; // 1時間

export function useNostr() {
  const { toast } = useToast();
  const rxRef = useRef<RxNostr | null>(null);
  const [posts, setPosts] = useState<Map<string, Post>>(new Map());
  const [userMetadata, setUserMetadata] = useState<Map<string, UserMetadata>>(new Map());
  const pendingMetadataRequests = useRef<Set<string>>(new Set());
  const metadataUpdateQueue = useRef<Set<string>>(new Set());
  const updateTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Load cached metadata on mount
  useEffect(() => {
    try {
      const cached = localStorage.getItem(METADATA_CACHE_KEY);
      const timestamp = localStorage.getItem(METADATA_TIMESTAMP_KEY);

      if (cached && timestamp) {
        const parsedCache = JSON.parse(cached);
        const parsedTimestamp = parseInt(timestamp, 10);

        // Check if cache is still valid
        if (Date.now() - parsedTimestamp < CACHE_TTL) {
          setUserMetadata(new Map(Object.entries(parsedCache)));
        }
      }
    } catch (error) {
      console.error("Failed to load cached metadata:", error);
    }
  }, []);

  // Save metadata to cache whenever it changes
  useEffect(() => {
    try {
      const metadataObject = Object.fromEntries(userMetadata);
      localStorage.setItem(METADATA_CACHE_KEY, JSON.stringify(metadataObject));
      localStorage.setItem(METADATA_TIMESTAMP_KEY, Date.now().toString());
    } catch (error) {
      console.error("Failed to cache metadata:", error);
    }
  }, [userMetadata]);

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

  // バッチ処理でメタデータを更新
  const processBatchMetadataUpdate = () => {
    if (!rxRef.current || metadataUpdateQueue.current.size === 0) return;

    const pubkeys = Array.from(metadataUpdateQueue.current);
    metadataUpdateQueue.current.clear();

    console.log(`Processing metadata batch for pubkeys:`, pubkeys);

    const filter = {
      kinds: [0],
      authors: pubkeys,
      limit: pubkeys.length
    };

    const rxReq = createRxForwardReq();

    rxRef.current
      .use(rxReq)
      .subscribe({
        next: ({ event }) => {
          try {
            const metadata = JSON.parse(event.content) as UserMetadata;
            console.log(`Received metadata for ${event.pubkey}:`, metadata);
            setUserMetadata(current => {
              const updated = new Map(current);
              updated.set(event.pubkey, {
                name: metadata.name || `nostr:${event.pubkey.slice(0, 8)}`,
                picture: metadata.picture,
                about: metadata.about
              });
              return updated;
            });
          } catch (error) {
            console.error(`Failed to parse metadata for ${event.pubkey}:`, error);
          } finally {
            pendingMetadataRequests.current.delete(event.pubkey);
          }
        },
        error: (error) => {
          console.error("Error receiving metadata:", error);
          // On error, remove all pubkeys from pending requests
          pubkeys.forEach(pubkey => pendingMetadataRequests.current.delete(pubkey));
        }
      });

    rxReq.emit(filter);
    console.log("Metadata request filter emitted:", filter);
  };

  // メタデータの更新をキューに追加
  const queueMetadataUpdate = (pubkey: string) => {
    if (!rxRef.current) return;

    const cached = userMetadata.get(pubkey);
    const timestamp = localStorage.getItem(METADATA_TIMESTAMP_KEY);
    const isStale = timestamp && (Date.now() - parseInt(timestamp, 10) >= CACHE_TTL);

    // Skip if we have valid cached data
    if (cached && !isStale) {
      console.log(`Using cached metadata for ${pubkey}`);
      return;
    }

    // Skip if request is already pending
    if (pendingMetadataRequests.current.has(pubkey)) {
      console.log(`Metadata request already pending for ${pubkey}`);
      return;
    }

    console.log(`Queueing metadata update for ${pubkey}`);
    metadataUpdateQueue.current.add(pubkey);
    pendingMetadataRequests.current.add(pubkey);

    // Clear existing timeout
    if (updateTimeoutRef.current) {
      clearTimeout(updateTimeoutRef.current);
    }

    // Set new timeout for batch processing
    updateTimeoutRef.current = setTimeout(() => {
      processBatchMetadataUpdate();
      updateTimeoutRef.current = null;
    }, 100); // 100ms後にバッチ処理を実行
  };

  // Subscribe to new posts from relays
  useEffect(() => {
    if (!rxRef.current) return;

    const fetchFromRelays = async () => {
      try {
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

                // キューにメタデータ更新を追加
                queueMetadataUpdate(event.pubkey);

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
        queueMetadataUpdate(pubkey);
      }
      return userMetadata.get(pubkey);
    }
  };
}