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
const EVENTS_CACHE_KEY = 'nostr_events_cache';
const EVENTS_TIMESTAMP_KEY = 'nostr_events_timestamp';
const CACHE_TTL = 1000 * 60 * 60; // 1時間
const EVENTS_CACHE_TTL = 1000 * 60 * 5; // 5分

// メモリ内キャッシュ
const metadataMemoryCache = new Map<string, { data: UserMetadata; timestamp: number; error?: string }>();
const eventsMemoryCache = new Map<string, { data: Post; timestamp: number }>();

export function useNostr() {
  const { toast } = useToast();
  const rxRef = useRef<RxNostr | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [posts, setPosts] = useState<Map<string, Post>>(new Map());
  const [userMetadata, setUserMetadata] = useState<Map<string, UserMetadata>>(new Map());
  const pendingMetadataRequests = useRef<Set<string>>(new Set());
  const metadataUpdateQueue = useRef<Set<string>>(new Set());
  const updateTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const batchSize = 50;
  const retryCount = useRef<Map<string, number>>(new Map());
  const MAX_RETRIES = 3;
  const [isSubscriptionReady, setIsSubscriptionReady] = useState(false);
  const activeSubscriptions = useRef<Set<string>>(new Set());
  const seenEvents = useRef<Set<string>>(new Set());
  const DEBUG = true;

  const debugLog = useCallback((message: string, ...args: any[]) => {
    if (DEBUG) {
      console.log(`[Nostr] ${message}`, ...args);
    }
  }, []);

  // Load cached events on mount
  useEffect(() => {
    try {
      const cached = localStorage.getItem(EVENTS_CACHE_KEY);
      const timestamp = localStorage.getItem(EVENTS_TIMESTAMP_KEY);

      if (cached && timestamp) {
        const parsedCache = JSON.parse(cached);
        const parsedTimestamp = parseInt(timestamp, 10);

        if (Date.now() - parsedTimestamp < EVENTS_CACHE_TTL) {
          const entries = Object.entries(parsedCache);
          entries.forEach(([key, value]) => {
            eventsMemoryCache.set(key, {
              data: value as Post,
              timestamp: parsedTimestamp
            });
            seenEvents.current.add(key);
          });
          setPosts(new Map(entries.map(([key, value]) => [key, value as Post])));
          debugLog(`Loaded ${entries.length} events from cache`);
        }
      }
    } catch (error) {
      debugLog('Error loading events cache:', error);
    }
  }, [debugLog]);

  // Save events to cache periodically
  useEffect(() => {
    const saveInterval = setInterval(() => {
      try {
        if (posts.size > 0) {
          const eventsObject = Object.fromEntries(posts);
          localStorage.setItem(EVENTS_CACHE_KEY, JSON.stringify(eventsObject));
          localStorage.setItem(EVENTS_TIMESTAMP_KEY, Date.now().toString());
          debugLog(`Saved ${posts.size} events to cache`);
        }
      } catch (error) {
        debugLog('Error saving events cache:', error);
      }
    }, 60000); // 1分ごと

    return () => clearInterval(saveInterval);
  }, [posts, debugLog]);

  // メタデータのクリーンアップ
  const cleanupMetadataRequests = useCallback(() => {
    debugLog("Cleaning up metadata requests");
    pendingMetadataRequests.current.clear();
    metadataUpdateQueue.current.clear();
    retryCount.current.clear();
    if (updateTimeoutRef.current) {
      clearTimeout(updateTimeoutRef.current);
      updateTimeoutRef.current = null;
    }
  }, [debugLog]);

  // Process metadata updates in batches
  const processBatchMetadataUpdate = useCallback(() => {
    if (!rxRef.current || metadataUpdateQueue.current.size === 0 || !isSubscriptionReady) return;

    const pubkeys = Array.from(metadataUpdateQueue.current).slice(0, batchSize);
    const unprocessedPubkeys = pubkeys.filter(key => !pendingMetadataRequests.current.has(key));

    if (unprocessedPubkeys.length === 0) return;

    debugLog(`Processing metadata batch for ${unprocessedPubkeys.length} pubkeys`);

    unprocessedPubkeys.forEach(key => {
      metadataUpdateQueue.current.delete(key);
      pendingMetadataRequests.current.add(key);
    });

    const subscriptionId = Math.random().toString(36).substring(7);
    activeSubscriptions.current.add(subscriptionId);

    const filter = {
      kinds: [0],
      authors: unprocessedPubkeys,
      limit: 1
    };

    debugLog(`Requesting metadata with filter:`, filter);

    const rxReq = createRxForwardReq();
    const timeoutMs = 5000; // タイムアウトを5秒に短縮

    const timeoutId = setTimeout(() => {
      if (activeSubscriptions.current.has(subscriptionId)) {
        debugLog(`Metadata request timeout for subscription ${subscriptionId}`);
        unprocessedPubkeys.forEach(pubkey => {
          const currentRetries = retryCount.current.get(pubkey) || 0;
          if (currentRetries < MAX_RETRIES) {
            debugLog(`Retrying metadata request for ${pubkey}, attempt ${currentRetries + 1}/${MAX_RETRIES}`);
            retryCount.current.set(pubkey, currentRetries + 1);
            metadataUpdateQueue.current.add(pubkey);
          } else {
            debugLog(`Max retries reached for ${pubkey}, using fallback`);
            metadataMemoryCache.set(pubkey, {
              data: { name: `nostr:${pubkey.slice(0, 8)}` },
              timestamp: Date.now(),
              error: 'Metadata fetch failed'
            });
          }
          pendingMetadataRequests.current.delete(pubkey);
        });
        activeSubscriptions.current.delete(subscriptionId);
      }
    }, timeoutMs);

    const subscription = rxRef.current
      .use(rxReq)
      .subscribe({
        next: ({ event }) => {
          if (!activeSubscriptions.current.has(subscriptionId)) return;

          try {
            debugLog(`Received metadata for ${event.pubkey}`);
            const metadata = JSON.parse(event.content) as UserMetadata;

            const processedMetadata = {
              name: metadata.name || `nostr:${event.pubkey.slice(0, 8)}`,
              picture: metadata.picture,
              about: metadata.about
            };

            metadataMemoryCache.set(event.pubkey, {
              data: processedMetadata,
              timestamp: Date.now()
            });

            setUserMetadata(current => {
              const updated = new Map(current);
              updated.set(event.pubkey, processedMetadata);
              return updated;
            });

            retryCount.current.delete(event.pubkey);
            debugLog(`Successfully processed metadata for ${event.pubkey}`);
          } catch (error) {
            debugLog(`Error processing metadata for ${event.pubkey}:`, error);
            const currentRetries = retryCount.current.get(event.pubkey) || 0;
            if (currentRetries < MAX_RETRIES) {
              metadataUpdateQueue.current.add(event.pubkey);
              retryCount.current.set(event.pubkey, currentRetries + 1);
            }
          } finally {
            pendingMetadataRequests.current.delete(event.pubkey);
          }
        },
        error: (error) => {
          if (!activeSubscriptions.current.has(subscriptionId)) return;
          debugLog(`Subscription ${subscriptionId} error:`, error);

          unprocessedPubkeys.forEach(pubkey => {
            const currentRetries = retryCount.current.get(pubkey) || 0;
            if (currentRetries < MAX_RETRIES) {
              metadataUpdateQueue.current.add(pubkey);
              retryCount.current.set(pubkey, currentRetries + 1);
            }
            pendingMetadataRequests.current.delete(pubkey);
          });
        },
        complete: () => {
          debugLog(`Subscription ${subscriptionId} completed`);
          clearTimeout(timeoutId);
          activeSubscriptions.current.delete(subscriptionId);
        }
      });

    rxReq.emit(filter);
    debugLog(`Emitted filter for subscription ${subscriptionId}`);

    // If there are more items in the queue, schedule next batch
    if (metadataUpdateQueue.current.size > 0) {
      updateTimeoutRef.current = setTimeout(() => {
        processBatchMetadataUpdate();
        updateTimeoutRef.current = null;
      }, 100);
    }

    return () => {
      subscription.unsubscribe();
      activeSubscriptions.current.delete(subscriptionId);
      debugLog(`Cleaned up subscription ${subscriptionId}`);
    };
  }, [isSubscriptionReady, debugLog]);

  // メタデータの更新をキューに追加
  const queueMetadataUpdate = useCallback((pubkey: string) => {
    if (!rxRef.current || !isSubscriptionReady) return;

    // Check memory cache first
    const memCached = metadataMemoryCache.get(pubkey);
    if (memCached && (Date.now() - memCached.timestamp < CACHE_TTL)) {
      // エラー状態のキャッシュの場合は再試行を検討
      if (memCached.error) {
        const currentRetries = retryCount.current.get(pubkey) || 0;
        if (currentRetries < MAX_RETRIES) {
          metadataUpdateQueue.current.add(pubkey);
          return;
        }
      }

      if (!userMetadata.has(pubkey)) {
        setUserMetadata(current => {
          const updated = new Map(current);
          updated.set(pubkey, memCached.data);
          return updated;
        });
      }
      return;
    }

    // Skip if request is already pending
    if (pendingMetadataRequests.current.has(pubkey)) {
      return;
    }

    // Skip if pubkey is already in the queue
    if (metadataUpdateQueue.current.has(pubkey)) {
      return;
    }

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
    }, 100);
  }, [userMetadata, processBatchMetadataUpdate, isSubscriptionReady]);

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
          const entries = Object.entries(parsedCache);
          // Update both memory cache and state
          entries.forEach(([key, value]) => {
            metadataMemoryCache.set(key, {
              data: value as UserMetadata,
              timestamp: parsedTimestamp
            });
          });
          setUserMetadata(new Map(entries));
        }
      }
    } catch (error) {}
  }, []);

  // Save metadata to cache periodically
  useEffect(() => {
    const saveInterval = setInterval(() => {
      try {
        if (userMetadata.size > 0) {
          const metadataObject = Object.fromEntries(userMetadata);
          localStorage.setItem(METADATA_CACHE_KEY, JSON.stringify(metadataObject));
          localStorage.setItem(METADATA_TIMESTAMP_KEY, Date.now().toString());
        }
      } catch (error) {}
    }, 60000); // Every minute

    return () => clearInterval(saveInterval);
  }, [userMetadata]);

  // Initialize rx-nostr and subscribe to events
  useEffect(() => {
    if (initialized || rxRef.current) {
      return;
    }

    try {
      debugLog("Initializing rx-nostr");
      rxRef.current = createRxNostr({ verifier });
      rxRef.current.setDefaultRelays(DEFAULT_RELAYS);
      setInitialized(true);

      const fetchFromRelays = async () => {
        try {
          const filter = {
            kinds: [1],
            limit: 30,
            since: Math.floor(Date.now() / 1000) - 24 * 60 * 60
          };

          debugLog("Subscribing to posts with filter:", filter);

          const rxReq = createRxForwardReq();
          const subscriptionId = Math.random().toString(36).substring(7);
          activeSubscriptions.current.add(subscriptionId);

          const subscription = rxRef.current!
            .use(rxReq)
            .subscribe({
              next: ({ event }) => {
                if (!activeSubscriptions.current.has(subscriptionId)) return;

                // Skip if we've already seen this event
                if (seenEvents.current.has(event.id)) {
                  debugLog(`Skipping duplicate event: ${event.id}`);
                  return;
                }

                debugLog(`Received new post from ${event.pubkey}`);
                seenEvents.current.add(event.id);

                const post: Post = {
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

                // Update memory cache
                eventsMemoryCache.set(event.id, {
                  data: post,
                  timestamp: Date.now()
                });

                setPosts(currentPosts => {
                  const updatedPosts = new Map(currentPosts);
                  updatedPosts.set(event.id, post);
                  return updatedPosts;
                });

                if (!pendingMetadataRequests.current.has(event.pubkey)) {
                  queueMetadataUpdate(event.pubkey);
                }
              },
              error: (error) => {
                if (!activeSubscriptions.current.has(subscriptionId)) return;
                debugLog("Post subscription error:", error);
                toast({
                  title: "エラー",
                  description: "データの取得中にエラーが発生しました",
                  variant: "destructive",
                });
              },
              complete: () => {
                debugLog(`Post subscription ${subscriptionId} completed`);
                activeSubscriptions.current.delete(subscriptionId);
              }
            });

          rxReq.emit(filter);
          debugLog(`Emitted post filter for subscription ${subscriptionId}`);
          setIsSubscriptionReady(true);

          return () => {
            subscription.unsubscribe();
            activeSubscriptions.current.delete(subscriptionId);
            debugLog(`Cleaned up post subscription ${subscriptionId}`);
          };
        } catch (error) {
          debugLog("Error in fetchFromRelays:", error);
          toast({
            title: "エラー",
            description: "初期化に失敗しました",
            variant: "destructive",
          });
        }
      };

      fetchFromRelays();
    } catch (error) {
      debugLog("Error during initialization:", error);
      toast({
        title: "エラー",
        description: "初期化に失敗しました",
        variant: "destructive",
      });
    }

    return () => {
      if (rxRef.current) {
        debugLog("Cleaning up rx-nostr");
        activeSubscriptions.current.clear();
        cleanupMetadataRequests();
        rxRef.current.dispose();
        rxRef.current = null;
        setInitialized(false);
        setIsSubscriptionReady(false);
        seenEvents.current.clear();
      }
    };
  }, [cleanupMetadataRequests, toast, debugLog]);


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
      // Check memory cache first
      const memCached = metadataMemoryCache.get(pubkey);
      if (memCached && (Date.now() - memCached.timestamp < CACHE_TTL)) {
        return memCached.data;
      }

      // Queue update if not in cache or expired
      if (!userMetadata.has(pubkey)) {
        queueMetadataUpdate(pubkey);
      }
      return userMetadata.get(pubkey);
    }, [userMetadata, queueMetadataUpdate])
  };
}