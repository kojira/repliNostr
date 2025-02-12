import { useMutation } from "@tanstack/react-query";
import { Post } from "@shared/schema";
import { useToast } from "./use-toast";
import { createRxNostr, createRxForwardReq } from 'rx-nostr';
import { verifier } from 'rx-nostr-crypto';
import { bytesToHex } from '@noble/hashes/utils';
import { useEffect, useRef, useState, useCallback } from "react";
import type { RxNostr } from 'rx-nostr';

// 定数定義
const METADATA_CACHE_KEY = 'nostr_metadata_cache';
const METADATA_TIMESTAMP_KEY = 'nostr_metadata_timestamp';
const EVENTS_CACHE_KEY = 'nostr_events_cache';
const EVENTS_TIMESTAMP_KEY = 'nostr_events_timestamp';
const CACHE_TTL = 1000 * 60 * 60 * 3; // 3時間
const EVENTS_CACHE_TTL = 1000 * 60 * 5; // 5分
const MAX_CACHED_METADATA = 1000;
const MAX_CACHED_EVENTS = 100;
const METADATA_BATCH_SIZE = 3;
const METADATA_REQUEST_INTERVAL = 3000;
const MAX_RETRIES = 3;
const METADATA_TIMEOUT = 10000;

// メモリ内キャッシュ
const metadataMemoryCache = new Map<string, { data: UserMetadata; timestamp: number; error?: string }>();
const eventsMemoryCache = new Map<string, { data: Post; timestamp: number }>();
const metadataRequestTimes = new Map<string, number>();
let isProcessingBatch = false;

// rx-nostrインスタンス管理
let globalRxInstance: RxNostr | null = null;
let globalInitialized = false;

interface UserMetadata {
  name?: string;
  picture?: string;
  about?: string;
}

const DEFAULT_RELAYS = [
  "wss://r.kojira.io",
  "wss://x.kojira.io",
];

const DEBUG = true;

export function useNostr() {
  const { toast } = useToast();
  const [initialized, setInitialized] = useState(false);
  const [isInitialLoadComplete, setIsInitialLoadComplete] = useState(false);
  const [posts, setPosts] = useState<Map<string, Post>>(new Map());
  const [userMetadata, setUserMetadata] = useState<Map<string, UserMetadata>>(new Map());
  const pendingMetadataRequests = useRef<Set<string>>(new Set());
  const metadataUpdateQueue = useRef<Set<string>>(new Set());
  const retryCount = useRef<Map<string, number>>(new Map());
  const [isSubscriptionReady, setIsSubscriptionReady] = useState(false);
  const activeSubscriptions = useRef<Set<string>>(new Set());
  const seenEvents = useRef<Set<string>>(new Set());
  const lastEventTimestamp = useRef<number>(0);
  const lastMetadataRequest = useRef<number>(0);

  const debugLog = useCallback((message: string, ...args: any[]) => {
    if (DEBUG) {
      console.log(`[Nostr ${new Date().toISOString()}] ${message}`, ...args);
    }
  }, []);

  // メタデータ更新の最適化されたバッチ処理
  const processBatchMetadataUpdate = useCallback(async () => {
    if (!globalRxInstance || metadataUpdateQueue.current.size === 0 || !isSubscriptionReady || isProcessingBatch) {
      debugLog(`Batch update skipped: rxInstance=${!!globalRxInstance}, queueSize=${metadataUpdateQueue.current.size}, ready=${isSubscriptionReady}, processing=${isProcessingBatch}`);
      return;
    }

    const now = Date.now();
    if (now - lastMetadataRequest.current < METADATA_REQUEST_INTERVAL) {
      debugLog(`Too soon for next batch, waiting... (${METADATA_REQUEST_INTERVAL - (now - lastMetadataRequest.current)}ms remaining)`);
      return;
    }

    isProcessingBatch = true;
    debugLog(`Starting batch metadata update with ${metadataUpdateQueue.current.size} items in queue`);

    try {
      const pubkeysToProcess = Array.from(metadataUpdateQueue.current)
        .filter(pubkey => !pendingMetadataRequests.current.has(pubkey))
        .slice(0, METADATA_BATCH_SIZE);

      if (pubkeysToProcess.length === 0) {
        debugLog('No pubkeys to process in this batch');
        isProcessingBatch = false;
        return;
      }

      debugLog(`Processing batch for pubkeys: ${pubkeysToProcess.join(', ')}`);
      lastMetadataRequest.current = now;

      const filter = {
        kinds: [0],
        authors: pubkeysToProcess,
        limit: 1
      };

      pubkeysToProcess.forEach(pubkey => {
        pendingMetadataRequests.current.add(pubkey);
        metadataUpdateQueue.current.delete(pubkey);
      });

      await new Promise((resolve, reject) => {
        const rxReq = createRxForwardReq();
        const timeoutId = setTimeout(() => {
          pubkeysToProcess.forEach(pubkey => {
            const currentRetries = retryCount.current.get(pubkey) || 0;
            if (currentRetries < MAX_RETRIES) {
              retryCount.current.set(pubkey, currentRetries + 1);
              metadataUpdateQueue.current.add(pubkey);
            } else {
              metadataMemoryCache.set(pubkey, {
                data: { name: `nostr:${pubkey.slice(0, 8)}` },
                timestamp: now,
                error: 'Metadata fetch failed'
              });
            }
            pendingMetadataRequests.current.delete(pubkey);
          });
          reject(new Error('Timeout'));
        }, METADATA_TIMEOUT);

        const subscription = globalRxInstance!
          .use(rxReq)
          .subscribe({
            next: ({ event }) => {
              try {
                const metadata = JSON.parse(event.content) as UserMetadata;
                const processedMetadata = {
                  name: metadata.name || `nostr:${event.pubkey.slice(0, 8)}`,
                  picture: metadata.picture,
                  about: metadata.about
                };

                metadataMemoryCache.set(event.pubkey, {
                  data: processedMetadata,
                  timestamp: now
                });

                setUserMetadata(current => {
                  if (!current.has(event.pubkey)) {
                    const updated = new Map(current);
                    updated.set(event.pubkey, processedMetadata);
                    return updated;
                  }
                  return current;
                });

                pendingMetadataRequests.current.delete(event.pubkey);
                retryCount.current.delete(event.pubkey);
              } catch (error) {
                const currentRetries = retryCount.current.get(event.pubkey) || 0;
                if (currentRetries < MAX_RETRIES) {
                  metadataUpdateQueue.current.add(event.pubkey);
                  retryCount.current.set(event.pubkey, currentRetries + 1);
                }
                pendingMetadataRequests.current.delete(event.pubkey);
              }
            },
            error: (error) => {
              reject(error);
            },
            complete: () => {
              clearTimeout(timeoutId);
              resolve(undefined);
            }
          });

        rxReq.emit(filter);

        return () => {
          subscription.unsubscribe();
          clearTimeout(timeoutId);
        };
      });
    } catch (error) {
      // エラーは無視し、次のバッチ処理で再試行
    } finally {
      isProcessingBatch = false;

      // 次のバッチ処理をスケジュール（現在のバッチが完了した後）
      if (metadataUpdateQueue.current.size > 0) {
        setTimeout(() => {
          processBatchMetadataUpdate();
        }, METADATA_REQUEST_INTERVAL);
      }
    }
  }, [isSubscriptionReady, debugLog]);

  // メタデータ取得の最適化されたインターフェース
  const loadPostMetadata = useCallback((pubkey: string) => {
    if (!globalRxInstance || !isSubscriptionReady || !isInitialLoadComplete) {
      debugLog(`Metadata load skipped: rxInstance=${!!globalRxInstance}, ready=${isSubscriptionReady}, initialLoad=${isInitialLoadComplete}`);
      return;
    }

    debugLog(`Attempting to load metadata for pubkey: ${pubkey}`);

    // メモリキャッシュをチェック
    const memCached = metadataMemoryCache.get(pubkey);
    if (memCached && (Date.now() - memCached.timestamp < CACHE_TTL)) {
      if (!memCached.error) {
        debugLog(`Using cached metadata for ${pubkey}:`, memCached.data);
        setUserMetadata(current => {
          if (!current.has(pubkey)) {
            const updated = new Map(current);
            updated.set(pubkey, memCached.data);
            return updated;
          }
          return current;
        });
        return;
      }
    }

    // リクエスト制御
    const lastRequest = metadataRequestTimes.get(pubkey) || 0;
    const now = Date.now();
    if (now - lastRequest < METADATA_REQUEST_INTERVAL) {
      debugLog(`Skipping request for ${pubkey} due to rate limiting`);
      return;
    }

    if (!pendingMetadataRequests.current.has(pubkey) && !metadataUpdateQueue.current.has(pubkey)) {
      debugLog(`Adding ${pubkey} to metadata update queue`);
      metadataUpdateQueue.current.add(pubkey);
      metadataRequestTimes.set(pubkey, now);

      if (!isProcessingBatch) {
        processBatchMetadataUpdate();
      }
    }
  }, [isSubscriptionReady, isInitialLoadComplete, processBatchMetadataUpdate, debugLog]);

  // イベントとキャッシュの更新
  const updatePostsAndCache = useCallback((event: any, post: Post) => {
    debugLog(`Processing event: ${event.id} from ${event.pubkey}`);

    eventsMemoryCache.set(event.id, {
      data: post,
      timestamp: Date.now()
    });

    setPosts(currentPosts => {
      const updatedPosts = new Map(currentPosts);
      updatedPosts.set(event.id, post);
      return updatedPosts;
    });

    // メタデータ取得を試みる（初期ロード完了後のみ）
    if (isInitialLoadComplete) {
      debugLog(`Initial load complete, requesting metadata for ${event.pubkey}`);
      loadPostMetadata(event.pubkey);
    } else {
      debugLog(`Initial load not complete, skipping metadata for ${event.pubkey}`);
    }
  }, [loadPostMetadata, isInitialLoadComplete]);

  // rx-nostrの初期化
  useEffect(() => {
    if (globalInitialized) {
      debugLog("Using existing rx-nostr instance");
      setInitialized(true);
      setIsSubscriptionReady(true);
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

        // イベント処理の共通関数
        const processEvent = (event: any) => {
          if (seenEvents.current.has(event.id)) {
            return;
          }

          debugLog(`New event received: ${event.id}`);
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

          updatePostsAndCache(event, post);
        };

        // 継続的なサブスクリプションと初期フェッチをセットアップ
        const setupSubscriptions = () => {
          debugLog("Setting up subscriptions");

          // 過去のイベントを取得
          const initialFilter = {
            kinds: [1],
            limit: 30,
            since: Math.floor(Date.now() / 1000) - 24 * 60 * 60
          };

          const rxReqInitial = createRxForwardReq();
          const initialSubscription = globalRxInstance!
            .use(rxReqInitial)
            .subscribe({
              next: ({ event }) => processEvent(event),
              error: (error) => {
                debugLog("Initial fetch error:", error);
                toast({
                  title: "エラー",
                  description: "初期データの取得に失敗しました",
                  variant: "destructive",
                });
              },
              complete: () => {
                debugLog("Initial fetch completed");
                setIsInitialLoadComplete(true);
              }
            });

          // リアルタイム更新用のサブスクリプション
          const continuousFilter = {
            kinds: [1],
            since: Math.floor(Date.now() / 1000)
          };

          debugLog("Setting up continuous subscription");
          const rxReqContinuous = createRxForwardReq();
          const continuousSubscription = globalRxInstance!
            .use(rxReqContinuous)
            .subscribe({
              next: ({ event }) => processEvent(event),
              error: (error) => {
                debugLog("Continuous subscription error:", error);
              }
            });

          // フィルターを発行
          rxReqInitial.emit(initialFilter);
          rxReqContinuous.emit(continuousFilter);

          return () => {
            initialSubscription.unsubscribe();
            continuousSubscription.unsubscribe();
            activeSubscriptions.current.clear();
          };
        };

        // サブスクリプションの準備が整ったことを通知
        setIsSubscriptionReady(true);
        debugLog("Subscription ready, starting setup");

        // サブスクリプションを開始
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

  // 初期ロード完了後のメタデータ取得
  useEffect(() => {
    if (isInitialLoadComplete && posts.size > 0) {
      debugLog(`Initial load complete with ${posts.size} posts, starting metadata fetch`);
      const uniquePubkeys = new Set<string>();
      posts.forEach(post => uniquePubkeys.add(post.pubkey));
      debugLog(`Found ${uniquePubkeys.size} unique pubkeys`);

      uniquePubkeys.forEach(pubkey => {
        debugLog(`Queueing metadata request for pubkey: ${pubkey}`);
        metadataUpdateQueue.current.add(pubkey);
      });

      if (!isProcessingBatch) {
        debugLog('Starting initial metadata batch processing');
        processBatchMetadataUpdate();
      }
    }
  }, [isInitialLoadComplete, posts, processBatchMetadataUpdate, debugLog]);

  const pruneMetadataCache = useCallback(() => {
    if (metadataMemoryCache.size > MAX_CACHED_METADATA) {
      const sortedEntries = Array.from(metadataMemoryCache.entries())
        .sort(([, a], [, b]) => b.timestamp - a.timestamp)
        .slice(0, MAX_CACHED_METADATA);

      metadataMemoryCache.clear();
      sortedEntries.forEach(([key, value]) => metadataMemoryCache.set(key, value));
    }
  }, []);

  useEffect(() => {
    const saveInterval = setInterval(() => {
      try {
        if (posts.size > 0) {
          const sortedPosts = Array.from(posts.entries())
            .sort(([, a], [, b]) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            .slice(0, MAX_CACHED_EVENTS);

          const eventsObject = Object.fromEntries(sortedPosts);
          localStorage.setItem(EVENTS_CACHE_KEY, JSON.stringify(eventsObject));
          localStorage.setItem(EVENTS_TIMESTAMP_KEY, Date.now().toString());
        }
      } catch (error) {
        debugLog('Error saving events cache:', error);
      }
    }, 60000);

    return () => clearInterval(saveInterval);
  }, [posts, debugLog]);

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
              timestamp: parsedTimestamp
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
      debugLog('Error loading events cache:', error);
    }
  }, [debugLog]);


  return {
    posts: Array.from(posts.values()).sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    ),
    isLoadingPosts: !initialized,
    getUserMetadata: useCallback((pubkey: string) => {
      const memCached = metadataMemoryCache.get(pubkey);
      if (memCached && (Date.now() - memCached.timestamp < CACHE_TTL)) {
        return memCached.data;
      }

      if (!userMetadata.has(pubkey)) {
        loadPostMetadata(pubkey);
      }
      return userMetadata.get(pubkey);
    }, [userMetadata, loadPostMetadata]),
    loadPostMetadata
  };
}