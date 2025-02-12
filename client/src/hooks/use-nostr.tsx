import { useMutation } from "@tanstack/react-query";
import { Post } from "@shared/schema";
import { useToast } from "./use-toast";
import { createRxNostr, createRxForwardReq } from 'rx-nostr';
import { verifier } from 'rx-nostr-crypto';
import { bytesToHex } from '@noble/hashes/utils';
import { useEffect, useRef, useState, useCallback } from "react";
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
  const [initialized, setInitialized] = useState(false);
  const [posts, setPosts] = useState<Map<string, Post>>(new Map());
  const [userMetadata, setUserMetadata] = useState<Map<string, UserMetadata>>(new Map());
  const pendingMetadataRequests = useRef<Set<string>>(new Set());
  const metadataUpdateQueue = useRef<Set<string>>(new Set());
  const updateTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Process metadata updates in batches
  const processBatchMetadataUpdate = useCallback(() => {
    if (!rxRef.current || metadataUpdateQueue.current.size === 0) return;

    const pubkeys = Array.from(metadataUpdateQueue.current);
    metadataUpdateQueue.current.clear();

    console.log(`[Nostr] Processing metadata batch for pubkeys:`, pubkeys);

    const filter = {
      kinds: [0],
      authors: pubkeys,
      limit: 1
    };

    const rxReq = createRxForwardReq();
    const metadataStartTime = Date.now();

    rxRef.current
      .use(rxReq)
      .subscribe({
        next: ({ event }) => {
          try {
            const metadata = JSON.parse(event.content) as UserMetadata;
            console.log(`[Nostr] Received metadata for ${event.pubkey} in ${Date.now() - metadataStartTime}ms:`, metadata);
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
            console.error(`[Nostr] Failed to parse metadata for ${event.pubkey}:`, error);
          } finally {
            pendingMetadataRequests.current.delete(event.pubkey);
          }
        },
        error: (error) => {
          console.error("[Nostr] Error receiving metadata:", error);
          pubkeys.forEach(pubkey => pendingMetadataRequests.current.delete(pubkey));
        }
      });

    console.log("[Nostr] Metadata request filter emitted:", filter);
    rxReq.emit(filter);
  }, []);

  // メタデータの更新をキューに追加
  const queueMetadataUpdate = useCallback((pubkey: string) => {
    if (!rxRef.current) return;

    const cached = userMetadata.get(pubkey);
    const timestamp = localStorage.getItem(METADATA_TIMESTAMP_KEY);
    const isStale = timestamp && (Date.now() - parseInt(timestamp, 10) >= CACHE_TTL);

    // Skip if we have valid cached data
    if (cached && !isStale) {
      console.log(`[Nostr] Using cached metadata for ${pubkey}`);
      return;
    }

    // Skip if request is already pending
    if (pendingMetadataRequests.current.has(pubkey)) {
      console.log(`[Nostr] Metadata request already pending for ${pubkey}`);
      return;
    }

    // Skip if pubkey is already in the queue
    if (metadataUpdateQueue.current.has(pubkey)) {
      console.log(`[Nostr] Metadata update already queued for ${pubkey}`);
      return;
    }

    console.log(`[Nostr] Queueing metadata update for ${pubkey}`);
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
    }, 500); // バッチ処理の間隔を500msに増やして重複を減らす
  }, [userMetadata, processBatchMetadataUpdate]);

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
          console.log("[Nostr] Loading cached metadata...");
          setUserMetadata(new Map(Object.entries(parsedCache)));
          console.log("[Nostr] Cached metadata loaded successfully");
        } else {
          console.log("[Nostr] Cached metadata is stale, will fetch fresh data");
        }
      }
    } catch (error) {
      console.error("[Nostr] Failed to load cached metadata:", error);
    }
  }, []);

  // Save metadata to cache whenever it changes
  useEffect(() => {
    try {
      const metadataObject = Object.fromEntries(userMetadata);
      localStorage.setItem(METADATA_CACHE_KEY, JSON.stringify(metadataObject));
      localStorage.setItem(METADATA_TIMESTAMP_KEY, Date.now().toString());
      console.log("[Nostr] Metadata cache updated");
    } catch (error) {
      console.error("[Nostr] Failed to cache metadata:", error);
    }
  }, [userMetadata]);

  // Initialize rx-nostr and set default relays
  useEffect(() => {
    if (initialized || rxRef.current) {
      console.log("[Nostr] Already initialized, skipping");
      return;
    }

    const startTime = Date.now();
    console.log("[Nostr] Initializing rx-nostr...");

    try {
      rxRef.current = createRxNostr({
        verifier
      });

      console.log("[Nostr] Setting default relays:", DEFAULT_RELAYS);
      rxRef.current.setDefaultRelays(DEFAULT_RELAYS);

      // Subscribe to new posts from relays
      const fetchFromRelays = async () => {
        try {
          console.log("[Nostr] Starting to fetch events from relays...");
          const filter = {
            kinds: [1],
            limit: 100,
            since: Math.floor(Date.now() / 1000) - 24 * 60 * 60 // Last 24 hours
          };

          const rxReq = createRxForwardReq();
          console.log("[Nostr] Created forward request with filter:", filter);

          let eventCount = 0;
          const fetchStartTime = Date.now();

          // Subscribe to events
          rxRef.current!
            .use(rxReq)
            .subscribe({
              next: ({ event }) => {
                eventCount++;
                console.log(`[Nostr] Received event #${eventCount}:`, {
                  id: event.id,
                  pubkey: event.pubkey,
                  time: Math.floor((Date.now() - fetchStartTime) / 1000) + 's'
                });

                // Add new event to posts Map if it doesn't exist
                setPosts(currentPosts => {
                  if (currentPosts.has(event.id)) {
                    console.log(`[Nostr] Event ${event.id} already exists, skipping`);
                    return currentPosts;
                  }

                  // キューにメタデータ更新を追加
                  queueMetadataUpdate(event.pubkey);

                  // Create a temporary post object
                  const newPost: Post = {
                    id: 0,
                    userId: 0,
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
                  console.log(`[Nostr] Added new post ${event.id}, total posts: ${updatedPosts.size}`);
                  return updatedPosts;
                });
              },
              error: (error) => {
                console.error("[Nostr] Error receiving events:", error);
                toast({
                  title: "イベント取得エラー",
                  description: "リレーからのイベント取得中にエラーが発生しました",
                  variant: "destructive",
                });
              }
            });

          // Emit filter to start subscription
          console.log("[Nostr] Emitting filter to start subscription");
          rxReq.emit(filter);
          console.log(`[Nostr] Setup completed in ${Date.now() - startTime}ms`);
          setInitialized(true);
        } catch (error) {
          console.error("[Nostr] Failed to fetch events from relays:", error);
          toast({
            title: "初期化エラー",
            description: "リレーからのイベント取得の設定に失敗しました",
            variant: "destructive",
          });
        }
      };

      fetchFromRelays();
    } catch (error) {
      console.error("[Nostr] Failed to initialize rx-nostr:", error);
      toast({
        title: "初期化エラー",
        description: "rx-nostrの初期化に失敗しました",
        variant: "destructive",
      });
    }

    return () => {
      if (rxRef.current) {
        console.log("[Nostr] Disposing rx-nostr...");
        rxRef.current.dispose();
        rxRef.current = null;
        setInitialized(false);
      }
    };
  }, []); // 依存配列を空にして、マウント時のみ実行されるようにする

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
        if (!rxRef.current) {
          throw new Error("rx-nostrが初期化されていません");
        }
        await rxRef.current.send(signedEvent);

        return signedEvent;
      } catch (error) {
        console.error("[Nostr] Failed to publish to Nostr relays:", error);
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
        if (!rxRef.current) {
          throw new Error("rx-nostrが初期化されていません");
        }
        await rxRef.current.send(signedEvent);

        return event.profile;
      } catch (error) {
        console.error("[Nostr] Failed to update profile:", error);
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
    isLoadingPosts: !initialized,
    createPost: createPostMutation.mutate,
    isCreatingPost: createPostMutation.isPending,
    updateProfile: updateProfileMutation.mutate,
    isUpdatingProfile: updateProfileMutation.isPending,
    getUserMetadata: useCallback((pubkey: string) => {
      if (!userMetadata.has(pubkey)) {
        queueMetadataUpdate(pubkey);
      }
      return userMetadata.get(pubkey);
    }, [userMetadata, queueMetadataUpdate])
  };
}