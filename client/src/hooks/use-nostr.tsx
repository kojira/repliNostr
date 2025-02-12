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
const METADATA_BATCH_SIZE = 3; // バッチサイズを3に減らしてさらに負荷を軽減
const METADATA_REQUEST_INTERVAL = 3000; // インターバルを3秒に増やしてさらに余裕を持たせる
const MAX_RETRIES = 3;
const METADATA_TIMEOUT = 10000; // タイムアウトを10秒に短縮

// メモリ内キャッシュ
const metadataMemoryCache = new Map<string, { data: UserMetadata; timestamp: number; error?: string }>();
const eventsMemoryCache = new Map<string, { data: Post; timestamp: number }>();
const metadataRequestTimes = new Map<string, number>();
let isProcessingBatch = false;
let isInitialLoadComplete = false;

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

const DEBUG = true; // デバッグログを有効化

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
  const lastMetadataRequest = useRef<number>(0);


  const debugLog = useCallback((message: string, ...args: any[]) => {
    if (DEBUG) {
      console.log(`[Nostr ${new Date().toISOString()}] ${message}`, ...args);
    }
  }, []);

  // キャッシュ管理の最適化
  const pruneMetadataCache = useCallback(() => {
    if (metadataMemoryCache.size > MAX_CACHED_METADATA) {
      const sortedEntries = Array.from(metadataMemoryCache.entries())
        .sort(([, a], [, b]) => b.timestamp - a.timestamp)
        .slice(0, MAX_CACHED_METADATA);

      metadataMemoryCache.clear();
      sortedEntries.forEach(([key, value]) => metadataMemoryCache.set(key, value));
    }
  }, []);

  // メタデータ更新の最適化されたバッチ処理
  const processBatchMetadataUpdate = useCallback(async () => {
    if (!globalRxInstance || metadataUpdateQueue.current.size === 0 || !isSubscriptionReady || isProcessingBatch || !isInitialLoadComplete) {
      debugLog(`Batch update skipped: rxInstance=${!!globalRxInstance}, queueSize=${metadataUpdateQueue.current.size}, ready=${isSubscriptionReady}, processing=${isProcessingBatch}, initialLoad=${isInitialLoadComplete}`);
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
      // キューから未処理のpubkeyを取得（最大METADATA_BATCH_SIZE件）
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

      // バッチでメタデータをリクエスト
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
  }, [isSubscriptionReady]);

  // メタデータ取得の最適化されたインターフェース
  const loadPostMetadata = useCallback((pubkey: string) => {
    if (!globalRxInstance || !isSubscriptionReady || !isInitialLoadComplete) {
      return;
    }

    // メモリキャッシュをチェック
    const memCached = metadataMemoryCache.get(pubkey);
    if (memCached && (Date.now() - memCached.timestamp < CACHE_TTL)) {
      if (!memCached.error) {
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
      return;
    }

    if (!pendingMetadataRequests.current.has(pubkey) && !metadataUpdateQueue.current.has(pubkey)) {
      metadataUpdateQueue.current.add(pubkey);
      metadataRequestTimes.set(pubkey, now);

      // バッチ処理が実行中でない場合のみ新しいバッチを開始
      if (!isProcessingBatch) {
        processBatchMetadataUpdate();
      }
    }
  }, [isSubscriptionReady, processBatchMetadataUpdate]);

  const updatePostsAndCache = useCallback((event: any, post: Post) => {
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
      loadPostMetadata(event.pubkey);
    }
  }, [loadPostMetadata]);

  // イベントキャッシュを保存
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

  // キャッシュからイベントを読み込み
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

  // rx-nostrの初期化
  useEffect(() => {
    if (globalInitialized) {
      setInitialized(true);
      setIsSubscriptionReady(true);
      return;
    }

    const initializeNostr = async () => {
      try {
        if (!globalRxInstance) {
          globalRxInstance = createRxNostr({ verifier });
          globalRxInstance.setDefaultRelays(DEFAULT_RELAYS);
          globalInitialized = true;
        }
        setInitialized(true);

        // イベント処理の共通関数
        const processEvent = (event: any) => {
          if (seenEvents.current.has(event.id)) {
            return;
          }

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
                toast({
                  title: "エラー",
                  description: "初期データの取得に失敗しました",
                  variant: "destructive",
                });
              },
              complete: () => {
                isInitialLoadComplete = true;
              }
            });

          // リアルタイム更新用のサブスクリプション
          const continuousFilter = {
            kinds: [1],
            since: Math.floor(Date.now() / 1000)
          };

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

        // サブスクリプションを開始
        return setupSubscriptions();

      } catch (error) {
        toast({
          title: "エラー",
          description: "初期化に失敗しました",
          variant: "destructive",
        });
      }
    };

    initializeNostr();
  }, [debugLog, toast, updatePostsAndCache]);

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