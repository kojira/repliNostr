import { useMutation } from "@tanstack/react-query";
import { Post } from "@shared/schema";
import { useToast } from "./use-toast";
import { createRxNostr, createRxForwardReq } from "rx-nostr";
import { verifier } from "rx-nostr-crypto";
import { bytesToHex } from "@noble/hashes/utils";
import { useEffect, useRef, useState, useCallback } from "react";
import type { RxNostr } from "rx-nostr";

const METADATA_CACHE_KEY = "nostr_metadata_cache";
const METADATA_TIMESTAMP_KEY = "nostr_metadata_timestamp";
const EVENTS_CACHE_KEY = "nostr_events_cache";
const EVENTS_TIMESTAMP_KEY = "nostr_events_timestamp";
const CACHE_TTL = 1000 * 60 * 60 * 3; // 3時間
const EVENTS_CACHE_TTL = 1000 * 60 * 5; // 5分
const MAX_CACHED_METADATA = 1000;
const MAX_CACHED_EVENTS = 100;
const MAX_RETRIES = 3;
const METADATA_TIMEOUT = 15000; // 15秒でタイムアウト

// メモリ内キャッシュ
const metadataMemoryCache = new Map<
  string,
  { data: UserMetadata; timestamp: number; error?: string }
>();
const eventsMemoryCache = new Map<string, { data: Post; timestamp: number }>();
let isProcessingMetadata = false;

// rx-nostrインスタンス管理
let globalRxInstance: RxNostr | null = null;
let globalInitialized = false;

interface UserMetadata {
  name?: string;
  picture?: string;
  about?: string;
}

const DEFAULT_RELAYS = ["wss://r.kojira.io", "wss://x.kojira.io"];

const DEBUG = true;

export function useNostr() {
  const { toast } = useToast();
  const [initialized, setInitialized] = useState(false);
  const [posts, setPosts] = useState<Map<string, Post>>(new Map());
  const [userMetadata, setUserMetadata] = useState<Map<string, UserMetadata>>(
    new Map(),
  );
  const retryCount = useRef<Map<string, number>>(new Map());
  const [isSubscriptionReady, setIsSubscriptionReady] = useState(false);
  const subscriptionReadyRef = useRef(false);
  const seenEvents = useRef<Set<string>>(new Set());
  const lastEventTimestamp = useRef<number>(0);
  const isInitialLoadComplete = useRef(false);
  const pendingMetadata = useRef<string[]>([]);

  const debugLog = useCallback((message: string, ...args: any[]) => {
    if (DEBUG) {
      console.log(`[Nostr ${new Date().toISOString()}] ${message}`, ...args);
    }
  }, []);


  // キャッシュの有効性をチェックする関数
  const isValidCache = useCallback((pubkey: string): boolean => {
    const cached = metadataMemoryCache.get(pubkey);
    return cached && 
           Date.now() - cached.timestamp < CACHE_TTL && 
           !cached.error;
  }, []);

  // キャッシュからメタデータを適用する関数
  const applyMetadataFromCache = useCallback((pubkey: string) => {
    const cached = metadataMemoryCache.get(pubkey);
    if (cached && !cached.error) {
      setUserMetadata((current) => {
        const updated = new Map(current);
        updated.set(pubkey, cached.data);
        return updated;
      });
    }
  }, []);

  // メタデータ取得の最適化されたインターフェース - シリアルに1件ずつ処理
  const loadPostMetadata = useCallback(
    async (pubkey: string) => {
      if (!globalRxInstance || !subscriptionReadyRef.current) {
        debugLog(
          `Metadata load skipped: rxInstance=${!!globalRxInstance}, ready=${subscriptionReadyRef.current}`,
        );
        return;
      }

      // 既に処理中の場合はキューに追加
      if (isProcessingMetadata) {
        if (!pendingMetadata.current.includes(pubkey)) {
          pendingMetadata.current.push(pubkey);
        }
        return;
      }

      isProcessingMetadata = true;
      debugLog(`Processing metadata for ${pubkey}`);

      try {
        const filter = {
          kinds: [0],
          authors: [pubkey],
        };

        await new Promise((resolve, reject) => {
          const rxReq = createRxForwardReq();
          const timeoutId = setTimeout(() => {
            debugLog(`Metadata request timeout for ${pubkey}`);
            const currentRetries = retryCount.current.get(pubkey) || 0;
            if (currentRetries < MAX_RETRIES) {
              retryCount.current.set(pubkey, currentRetries + 1);
              pendingMetadata.current.push(pubkey); // リトライのためにキューに追加
            } else {
              debugLog(`Max retries reached for pubkey: ${pubkey}`);
              metadataMemoryCache.set(pubkey, {
                data: { name: `nostr:${pubkey.slice(0, 8)}` },
                timestamp: Date.now(),
                error: "Metadata fetch failed after max retries",
              });
            }
            reject(new Error("Timeout"));
          }, METADATA_TIMEOUT);

          const subscription = globalRxInstance!.use(rxReq).subscribe({
            next: ({ event }) => {
              try {
                debugLog(`Received metadata for pubkey: ${event.pubkey}`);
                const metadata = JSON.parse(event.content) as UserMetadata;
                const processedMetadata = {
                  name: metadata.name || `nostr:${event.pubkey.slice(0, 8)}`,
                  picture: metadata.picture,
                  about: metadata.about,
                };

                // メタデータをキャッシュに保存
                metadataMemoryCache.set(event.pubkey, {
                  data: processedMetadata,
                  timestamp: Date.now(),
                });

                // UIの状態を更新
                setUserMetadata((current) => {
                  const updated = new Map(current);
                  updated.set(event.pubkey, processedMetadata);
                  return updated;
                });

                retryCount.current.delete(event.pubkey);
                resolve(undefined);
              } catch (error) {
                debugLog("Error processing metadata:", error);
                reject(error);
              }
            },
            error: (error) => {
              debugLog("Metadata request error:", error);
              reject(error);
            },
            complete: () => {
              clearTimeout(timeoutId);
              resolve(undefined);
            },
          });

          rxReq.emit(filter);

          return () => {
            subscription.unsubscribe();
            clearTimeout(timeoutId);
          };
        });
      } catch (error) {
        debugLog(`Error fetching metadata for ${pubkey}:`, error);
      } finally {
        isProcessingMetadata = false;
        // キューに溜まっているメタデータを処理
        const nextPubkey = pendingMetadata.current.shift();
        if (nextPubkey) {
          loadPostMetadata(nextPubkey);
        }
      }
    },
    [debugLog],
  );

  // イベントとキャッシュの更新
  const updatePostsAndCache = useCallback(
    (event: any, post: Post) => {
      debugLog(`Processing event: ${event.id} from ${event.pubkey}`);

      eventsMemoryCache.set(event.id, {
        data: post,
        timestamp: Date.now(),
      });

      setPosts((currentPosts) => {
        const updatedPosts = new Map(currentPosts);
        updatedPosts.set(event.id, post);
        return updatedPosts;
      });

      // キャッシュされたメタデータがあれば即座に適用し、なければ非同期で取得
      if (isValidCache(event.pubkey)) {
        debugLog(`Using cached metadata for ${event.pubkey}`);
        applyMetadataFromCache(event.pubkey);
      } else {
        loadPostMetadata(event.pubkey);
      }
    },
    [debugLog, loadPostMetadata, isValidCache, applyMetadataFromCache],
  );

  // rx-nostrの初期化
  useEffect(() => {
    if (globalInitialized) {
      debugLog("Using existing rx-nostr instance");
      setInitialized(true);
      setIsSubscriptionReady(true);
      subscriptionReadyRef.current = true;
      return;
    }

    const initializeNostr = async () => {
      try {
        debugLog("Starting rx-nostr initialization");
        if (!globalRxInstance) {
          globalRxInstance = createRxNostr({ verifier });
          globalRxInstance.setDefaultRelays(DEFAULT_RELAYS);
          globalInitialized = true;
          debugLog("Created new rx-nostr instance");
        }
        setInitialized(true);

        const setupSubscriptions = () => {
          debugLog("Setting up subscriptions");

          const initialFilter = {
            kinds: [1],
            limit: 30,
            since: Math.floor(Date.now() / 1000) - 24 * 60 * 60,
          };

          const rxReqInitial = createRxForwardReq();
          let initialEventsReceived = 0;

          const initialSubscription = globalRxInstance!
            .use(rxReqInitial)
            .subscribe({
              next: ({ event }) => {
                if (!seenEvents.current.has(event.id)) {
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
                      relays: DEFAULT_RELAYS,
                    },
                  };
                  updatePostsAndCache(event, post);
                  initialEventsReceived++;
                }
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
                debugLog(`Initial fetch completed with ${initialEventsReceived} events`);
                setIsSubscriptionReady(true);
                subscriptionReadyRef.current = true;
                isInitialLoadComplete.current = true;
              },
            });

          const continuousFilter = {
            kinds: [1],
            since: Math.floor(Date.now() / 1000),
          };

          debugLog("Setting up continuous subscription");
          const rxReqContinuous = createRxForwardReq();
          const continuousSubscription = globalRxInstance!
            .use(rxReqContinuous)
            .subscribe({
              next: ({ event }) => {
                if (!seenEvents.current.has(event.id)) {
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
                      relays: DEFAULT_RELAYS,
                    },
                  };
                  updatePostsAndCache(event, post);
                }
              },
              error: (error) => {
                debugLog("Continuous subscription error:", error);
              },
            });

          rxReqInitial.emit(initialFilter);
          rxReqContinuous.emit(continuousFilter);

          return () => {
            initialSubscription.unsubscribe();
            continuousSubscription.unsubscribe();
          };
        };

        return setupSubscriptions();
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
  }, [debugLog, toast, updatePostsAndCache]);

  // キャッシュ管理
  const pruneMetadataCache = useCallback(() => {
    if (metadataMemoryCache.size > MAX_CACHED_METADATA) {
      const sortedEntries = Array.from(metadataMemoryCache.entries())
        .sort(([, a], [, b]) => b.timestamp - a.timestamp)
        .slice(0, MAX_CACHED_METADATA);

      metadataMemoryCache.clear();
      sortedEntries.forEach(([key, value]) =>
        metadataMemoryCache.set(key, value),
      );
    }
  }, []);

  // キャッシュからの初期読み込み
  useEffect(() => {
    try {
      const cached = localStorage.getItem(EVENTS_CACHE_KEY);
      const timestamp = localStorage.getItem(EVENTS_TIMESTAMP_KEY);

      if (cached && timestamp) {
        const parsedCache = JSON.parse(cached);
        const parsedTimestamp = parseInt(timestamp, 10);

        if (Date.now() - parsedTimestamp < EVENTS_CACHE_TTL) {
          const entries = Object.entries(parsedCache);
          setPosts(new Map(entries.map(([key, value]) => [key, value as Post])));
          entries.forEach(([key, value]) => {
            const post = value as Post;
            eventsMemoryCache.set(key, {
              data: post,
              timestamp: parsedTimestamp,
            });
            seenEvents.current.add(key);
            const eventTime = new Date(post.createdAt).getTime() / 1000;
            if (eventTime > lastEventTimestamp.current) {
              lastEventTimestamp.current = eventTime;
            }
          });
        }
      }
    } catch (error) {
      debugLog("Error loading events cache:", error);
    }
  }, [debugLog]);

  return {
    posts: Array.from(posts.values()).sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    ),
    isLoadingPosts: !initialized,
    getUserMetadata: useCallback(
      (pubkey: string) => {
        const memCached = metadataMemoryCache.get(pubkey);
        if (memCached && Date.now() - memCached.timestamp < CACHE_TTL) {
          return memCached.data;
        }
        return userMetadata.get(pubkey);
      },
      [userMetadata],
    ),
    loadPostMetadata,
  };
}