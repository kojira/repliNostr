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

// シングルトンとしてrx-nostrインスタンスを管理
let globalRxInstance: RxNostr | null = null;
let globalInitialized = false;

export function useNostr() {
  const { toast } = useToast();
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
  const lastEventTimestamp = useRef<number>(0);
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
            const post = value as Post;
            eventsMemoryCache.set(key, {
              data: post,
              timestamp: parsedTimestamp
            });
            seenEvents.current.add(key);
            const eventTime = new Date(post.createdAt).getTime() / 1000;
            if (eventTime > lastEventTimestamp.current) {
              lastEventTimestamp.current = eventTime;
            }
            // キャッシュからの投稿表示時にメタデータを取得
            queueMetadataUpdate(post.pubkey);
          });
          setPosts(new Map(entries.map(([key, value]) => [key, value as Post])));
          debugLog(`Loaded ${entries.length} events from cache`);
        }
      }
    } catch (error) {
      debugLog('Error loading events cache:', error);
    }
  }, []);

  // Process metadata updates in batches
  const processBatchMetadataUpdate = useCallback(() => {
    if (!globalRxInstance || metadataUpdateQueue.current.size === 0 || !isSubscriptionReady) return;

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
    const timeoutMs = 5000;

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

    const subscription = globalRxInstance
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
    if (!globalRxInstance || !isSubscriptionReady) return;

    const memCached = metadataMemoryCache.get(pubkey);
    if (memCached && (Date.now() - memCached.timestamp < CACHE_TTL)) {
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

    if (pendingMetadataRequests.current.has(pubkey) || metadataUpdateQueue.current.has(pubkey)) {
      return;
    }

    metadataUpdateQueue.current.add(pubkey);

    if (updateTimeoutRef.current) {
      clearTimeout(updateTimeoutRef.current);
    }

    updateTimeoutRef.current = setTimeout(() => {
      processBatchMetadataUpdate();
      updateTimeoutRef.current = null;
    }, 100);
  }, [userMetadata, processBatchMetadataUpdate, isSubscriptionReady]);

  // Initialize rx-nostr once
  useEffect(() => {
    // グローバルインスタンスが既に存在する場合は再利用
    if (globalInitialized) {
      setInitialized(true);
      setIsSubscriptionReady(true);
      return;
    }

    const initializeNostr = async () => {
      try {
        debugLog("Initializing rx-nostr");
        if (!globalRxInstance) {
          globalRxInstance = createRxNostr({ verifier });
          globalRxInstance.setDefaultRelays(DEFAULT_RELAYS);
          globalInitialized = true;
        }
        setInitialized(true);

        // 過去のイベントを取得する関数
        const fetchInitialEvents = () => {
          const initialFilter = {
            kinds: [1],
            limit: 30,
            since: Math.floor(Date.now() / 1000) - 24 * 60 * 60
          };

          debugLog("Fetching initial events with filter:", initialFilter);

          const rxReq = createRxForwardReq();
          const subscriptionId = Math.random().toString(36).substring(7);
          activeSubscriptions.current.add(subscriptionId);

          return globalRxInstance!
            .use(rxReq)
            .subscribe({
              next: ({ event }) => {
                if (!activeSubscriptions.current.has(subscriptionId)) return;

                if (seenEvents.current.has(event.id)) {
                  debugLog(`Skipping duplicate initial event: ${event.id}`);
                  return;
                }

                debugLog(`Received initial event from ${event.pubkey}`);
                processEvent(event);
              },
              error: (error) => {
                debugLog("Initial fetch error:", error);
                toast({
                  title: "エラー",
                  description: "初期データの取得に失敗しました",
                  variant: "destructive",
                });
              },
              complete: () => {
                debugLog("Initial fetch completed, setting up continuous subscription");
                activeSubscriptions.current.delete(subscriptionId);
                setupContinuousSubscription();
              }
            });
        };

        // 継続的なサブスクリプションを設定する関数
        const setupContinuousSubscription = () => {
          const continuousFilter = {
            kinds: [1],
            since: lastEventTimestamp.current + 1
          };

          debugLog("Setting up continuous subscription with filter:", continuousFilter);

          const rxReq = createRxForwardReq();
          rxReq.emit(continuousFilter);

          return globalRxInstance!
            .use(rxReq)
            .subscribe({
              next: ({ event }) => processEvent(event),
              error: (error) => {
                debugLog("Continuous subscription error:", error);
              }
            });
        };

        // イベントを処理する共通関数
        const processEvent = (event: any) => {
          if (seenEvents.current.has(event.id)) {
            debugLog(`Skipping duplicate event: ${event.id}`);
            return;
          }

          seenEvents.current.add(event.id);

          if (event.created_at > lastEventTimestamp.current) {
            lastEventTimestamp.current = event.created_at;
          }

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
        };

        // 初期フェッチを開始
        const initialSubscription = fetchInitialEvents();
        setIsSubscriptionReady(true);

        return () => {
          initialSubscription.unsubscribe();
          activeSubscriptions.current.clear();
          debugLog("Cleaned up all subscriptions");
        };
      } catch (error) {
        debugLog("Error during initialization:", error);
        toast({
          title: "エラー",
          description: "初期化に失敗しました",
          variant: "destructive",
        });
      }
    };

    initializeNostr();

    return () => {
      if (globalRxInstance) {
        debugLog("Cleaning up rx-nostr");
        activeSubscriptions.current.clear();
        seenEvents.current.clear();
      }
    };
  }, []); // 依存配列を空にして一度だけ初期化

  const createPostMutation = useMutation({
    mutationFn: async (event: { content: string; pubkey: string; privateKey: string }) => {
      try {
        const nostrEvent = {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: event.content,
          pubkey: event.pubkey
        };

        const id = await window.crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(JSON.stringify([0, nostrEvent.pubkey, nostrEvent.created_at, nostrEvent.kind, nostrEvent.tags, nostrEvent.content]))
        );
        const signedEvent = {
          ...nostrEvent,
          id: bytesToHex(new Uint8Array(id)),
          sig: event.privateKey
        };

        if (!globalRxInstance) {
          throw new Error("rx-nostrが初期化されていません");
        }
        await globalRxInstance.send(signedEvent);

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
        const content = JSON.stringify(event.profile);

        const nostrEvent = {
          kind: 0,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content,
          pubkey: event.pubkey
        };

        const id = await window.crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(JSON.stringify([0, nostrEvent.pubkey, nostrEvent.created_at, nostrEvent.kind, nostrEvent.tags, nostrEvent.content]))
        );
        const signedEvent = {
          ...nostrEvent,
          id: bytesToHex(new Uint8Array(id)),
          sig: event.privateKey
        };

        if (!globalRxInstance) {
          throw new Error("rx-nostrが初期化されていません");
        }
        await globalRxInstance.send(signedEvent);

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
      const memCached = metadataMemoryCache.get(pubkey);
      if (memCached && (Date.now() - memCached.timestamp < CACHE_TTL)) {
        return memCached.data;
      }

      if (!userMetadata.has(pubkey)) {
        queueMetadataUpdate(pubkey);
      }
      return userMetadata.get(pubkey);
    }, [userMetadata, queueMetadataUpdate])
  };
}