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
const METADATA_BATCH_SIZE = 2; // バッチサイズを2に減らす
const METADATA_REQUEST_INTERVAL = 5000; // インターバルを5秒に増やす
const MAX_RETRIES = 3;
const METADATA_TIMEOUT = 15000; // タイムアウトを15秒に増やす
const BATCH_COOLDOWN = 10000; // バッチ処理のクールダウン時間を10秒に設定

// メモリ内キャッシュ
const metadataMemoryCache = new Map<string, { data: UserMetadata; timestamp: number; error?: string }>();
const eventsMemoryCache = new Map<string, { data: Post; timestamp: number }>();
const metadataRequestTimes = new Map<string, number>();
let isProcessingBatch = false;
let lastBatchTime = 0;

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
  const [posts, setPosts] = useState<Map<string, Post>>(new Map());
  const [userMetadata, setUserMetadata] = useState<Map<string, UserMetadata>>(new Map());
  const pendingMetadataRequests = useRef<Set<string>>(new Set());
  const metadataUpdateQueue = useRef<Set<string>>(new Set());
  const retryCount = useRef<Map<string, number>>(new Map());
  const [isSubscriptionReady, setIsSubscriptionReady] = useState(false);
  const activeSubscriptions = useRef<Set<string>>(new Set());
  const seenEvents = useRef<Set<string>>(new Set());
  const lastEventTimestamp = useRef<number>(0);

  const debugLog = useCallback((message: string, ...args: any[]) => {
    if (DEBUG) {
      console.log(`[Nostr ${new Date().toISOString()}] ${message}`, ...args);
    }
  }, []);

  // メタデータ更新の最適化されたバッチ処理
  const processBatchMetadataUpdate = useCallback(async () => {
    const now = Date.now();

    // バッチ処理のクールダウンチェック
    if (now - lastBatchTime < BATCH_COOLDOWN) {
      debugLog(`Batch update cooling down: ${BATCH_COOLDOWN - (now - lastBatchTime)}ms remaining`);
      return;
    }

    if (!globalRxInstance || metadataUpdateQueue.current.size === 0 || !isSubscriptionReady || isProcessingBatch) {
      debugLog(`Batch update skipped: rxInstance=${!!globalRxInstance}, queueSize=${metadataUpdateQueue.current.size}, ready=${isSubscriptionReady}, processing=${isProcessingBatch}`);
      return;
    }

    isProcessingBatch = true;
    lastBatchTime = now;
    debugLog(`Starting batch metadata update with ${metadataUpdateQueue.current.size} items in queue`);

    try {
      const pubkeysToProcess = Array.from(metadataUpdateQueue.current)
        .filter(pubkey => {
          const lastRequest = metadataRequestTimes.get(pubkey) || 0;
          return !pendingMetadataRequests.current.has(pubkey) && 
                 (now - lastRequest > METADATA_REQUEST_INTERVAL);
        })
        .slice(0, METADATA_BATCH_SIZE);

      if (pubkeysToProcess.length === 0) {
        debugLog('No pubkeys to process in this batch');
        isProcessingBatch = false;
        return;
      }

      debugLog(`Processing batch for pubkeys: ${pubkeysToProcess.join(', ')}`);

      pubkeysToProcess.forEach(pubkey => {
        pendingMetadataRequests.current.add(pubkey);
        metadataUpdateQueue.current.delete(pubkey);
        metadataRequestTimes.set(pubkey, now);
      });

      const filter = {
        kinds: [0],
        authors: pubkeysToProcess,
        limit: 1
      };

      await new Promise((resolve, reject) => {
        const rxReq = createRxForwardReq();
        const timeoutId = setTimeout(() => {
          debugLog(`Metadata request timeout for pubkeys: ${pubkeysToProcess.join(', ')}`);
          pubkeysToProcess.forEach(pubkey => {
            const currentRetries = retryCount.current.get(pubkey) || 0;
            if (currentRetries < MAX_RETRIES) {
              retryCount.current.set(pubkey, currentRetries + 1);
              metadataUpdateQueue.current.add(pubkey);
            } else {
              debugLog(`Max retries reached for pubkey: ${pubkey}`);
              metadataMemoryCache.set(pubkey, {
                data: { name: `nostr:${pubkey.slice(0, 8)}` },
                timestamp: now,
                error: 'Metadata fetch failed after max retries'
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
                debugLog(`Received metadata for pubkey: ${event.pubkey}`);
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
                  const updated = new Map(current);
                  updated.set(event.pubkey, processedMetadata);
                  return updated;
                });

                pendingMetadataRequests.current.delete(event.pubkey);
                retryCount.current.delete(event.pubkey);
              } catch (error) {
                debugLog('Error processing metadata:', error);
                const currentRetries = retryCount.current.get(event.pubkey) || 0;
                if (currentRetries < MAX_RETRIES) {
                  metadataUpdateQueue.current.add(event.pubkey);
                  retryCount.current.set(event.pubkey, currentRetries + 1);
                }
                pendingMetadataRequests.current.delete(event.pubkey);
              }
            },
            error: (error) => {
              debugLog('Metadata request error:', error);
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
      debugLog('Error in batch update:', error);
    } finally {
      isProcessingBatch = false;

      // 次のバッチ処理をスケジュール
      if (metadataUpdateQueue.current.size > 0) {
        setTimeout(() => {
          processBatchMetadataUpdate();
        }, METADATA_REQUEST_INTERVAL);
      }
    }
  }, [isSubscriptionReady, debugLog]);

  // メタデータ取得の最適化されたインターフェース
  const loadPostMetadata = useCallback((pubkey: string) => {
    if (!globalRxInstance || !isSubscriptionReady) {
      debugLog(`Metadata load skipped: rxInstance=${!!globalRxInstance}, ready=${isSubscriptionReady}`);
      return;
    }

    // キャッシュチェック
    const memCached = metadataMemoryCache.get(pubkey);
    if (memCached && (Date.now() - memCached.timestamp < CACHE_TTL)) {
      debugLog(`Using cached metadata for ${pubkey}`);
      if (!memCached.error) {
        setUserMetadata(current => {
          const updated = new Map(current);
          updated.set(pubkey, memCached.data);
          return updated;
        });
        return;
      }
    }

    // レート制限チェック
    const lastRequest = metadataRequestTimes.get(pubkey) || 0;
    if (Date.now() - lastRequest < METADATA_REQUEST_INTERVAL) {
      debugLog(`Rate limiting metadata request for ${pubkey}`);
      return;
    }

    // リクエストキューに追加
    if (!pendingMetadataRequests.current.has(pubkey) && !metadataUpdateQueue.current.has(pubkey)) {
      debugLog(`Adding ${pubkey} to metadata update queue`);
      metadataUpdateQueue.current.add(pubkey);

      if (!isProcessingBatch) {
        processBatchMetadataUpdate();
      }
    }
  }, [isSubscriptionReady, processBatchMetadataUpdate, debugLog]);

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

    loadPostMetadata(event.pubkey);
  }, [loadPostMetadata]);

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

        const setupSubscriptions = () => {
          debugLog("Setting up subscriptions");

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
              }
            });

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

          rxReqInitial.emit(initialFilter);
          rxReqContinuous.emit(continuousFilter);

          return () => {
            initialSubscription.unsubscribe();
            continuousSubscription.unsubscribe();
            activeSubscriptions.current.clear();
          };
        };

        setIsSubscriptionReady(true);
        debugLog("Subscription ready, starting setup");

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
      sortedEntries.forEach(([key, value]) => metadataMemoryCache.set(key, value));
    }
  }, []);

  // イベントキャッシュの管理
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