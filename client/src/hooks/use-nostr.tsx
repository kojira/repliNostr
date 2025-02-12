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
const METADATA_BATCH_SIZE = 10; // 一度に10件のメタデータをリクエスト
const MAX_RETRIES = 3;
const METADATA_TIMEOUT = 15000; // 15秒でタイムアウト

// メモリ内キャッシュ
const metadataMemoryCache = new Map<
  string,
  { data: UserMetadata; timestamp: number; error?: string }
>();
const eventsMemoryCache = new Map<string, { data: Post; timestamp: number }>();
let isProcessingBatch = false;

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
  const pendingBatches = useRef<Set<string>>(new Set());

  const debugLog = useCallback((message: string, ...args: any[]) => {
    if (DEBUG) {
      console.log(`[Nostr ${new Date().toISOString()}] ${message}`, ...args);
    }
  }, []);

  // メタデータ更新の最適化されたバッチ処理
  const processBatchMetadataUpdate = useCallback(async () => {
    if (!globalRxInstance || !subscriptionReadyRef.current || isProcessingBatch) {
      debugLog(
        `Metadata load skipped: rxInstance=${!!globalRxInstance}, ready=${subscriptionReadyRef.current}, initialLoad=${isInitialLoadComplete.current}`,
      );
      return;
    }

    // 全イベントからユニークなpubkeyを収集
    const uniquePubkeys = new Set<string>();
    posts.forEach((post) => {
      if (
        !metadataMemoryCache.has(post.pubkey) ||
        Date.now() - (metadataMemoryCache.get(post.pubkey)?.timestamp || 0) >
          CACHE_TTL
      ) {
        uniquePubkeys.add(post.pubkey);
      }
    });

    if (uniquePubkeys.size === 0) {
      debugLog("No new pubkeys to process");
      return;
    }

    isProcessingBatch = true;
    const now = Date.now();

    try {
      // pubkeyをバッチサイズごとに処理
      const pubkeysArray = Array.from(uniquePubkeys);
      for (let i = 0; i < pubkeysArray.length; i += METADATA_BATCH_SIZE) {
        const batch = pubkeysArray.slice(i, i + METADATA_BATCH_SIZE);
        debugLog(
          `Processing batch ${i / METADATA_BATCH_SIZE + 1}: ${batch.join(", ")}`,
        );

        const filter = {
          kinds: [0],
          authors: batch,
        };

        await new Promise((resolve, reject) => {
          const rxReq = createRxForwardReq();
          const timeoutId = setTimeout(() => {
            debugLog(`Metadata request timeout for batch: ${batch.join(", ")}`);
            batch.forEach((pubkey) => {
              const currentRetries = retryCount.current.get(pubkey) || 0;
              if (currentRetries < MAX_RETRIES) {
                retryCount.current.set(pubkey, currentRetries + 1);
              } else {
                debugLog(`Max retries reached for pubkey: ${pubkey}`);
                metadataMemoryCache.set(pubkey, {
                  data: { name: `nostr:${pubkey.slice(0, 8)}` },
                  timestamp: now,
                  error: "Metadata fetch failed after max retries",
                });
              }
            });
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
                  timestamp: now,
                });

                // UIの状態を更新
                setUserMetadata((current) => {
                  const updated = new Map(current);
                  updated.set(event.pubkey, processedMetadata);
                  return updated;
                });

                retryCount.current.delete(event.pubkey);
              } catch (error) {
                debugLog("Error processing metadata:", error);
              }
            },
            error: (error) => {
              debugLog("Metadata request error:", error);
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
      }
    } catch (error) {
      debugLog("Error in batch update:", error);
    } finally {
      isProcessingBatch = false;
    }
  }, [posts, debugLog]);

  // メタデータ取得の最適化されたインターフェース
  const loadPostMetadata = useCallback(
    (pubkey: string) => {
      if (!globalRxInstance || !subscriptionReadyRef.current) {
        debugLog(
          `Metadata load skipped: rxInstance=${!!globalRxInstance}, ready=${subscriptionReadyRef.current}`,
        );
        return;
      }

      // キャッシュをチェック
      const memCached = metadataMemoryCache.get(pubkey);
      if (memCached && Date.now() - memCached.timestamp < CACHE_TTL) {
        debugLog(`Using cached metadata for ${pubkey}`);
        if (!memCached.error) {
          setUserMetadata((current) => {
            const updated = new Map(current);
            updated.set(pubkey, memCached.data);
            return updated;
          });
        }
        return;
      }

      // 非同期でバッチ処理を開始
      if (!isProcessingBatch && !pendingBatches.current.has(pubkey)) {
        pendingBatches.current.add(pubkey);
        processBatchMetadataUpdate()
          .catch((error) => debugLog("Error in metadata update:", error))
          .finally(() => pendingBatches.current.delete(pubkey));
      }
    },
    [debugLog, processBatchMetadataUpdate],
  );

  // イベントとキャッシュの更新
  const updatePostsAndCache = useCallback(
    (event: any, post: Post) => {
      debugLog(`Processing event: ${event.id} from ${event.pubkey}`);

      if (!isInitialLoadComplete.current) {
        debugLog(
          `Initial load not complete, skipping metadata for ${event.pubkey}`,
        );
        return;
      }

      eventsMemoryCache.set(event.id, {
        data: post,
        timestamp: Date.now(),
      });

      setPosts((currentPosts) => {
        const updatedPosts = new Map(currentPosts);
        updatedPosts.set(event.id, post);
        return updatedPosts;
      });

      // キャッシュされたメタデータがあれば即座に適用
      const cachedMetadata = metadataMemoryCache.get(event.pubkey);
      if (
        cachedMetadata &&
        Date.now() - cachedMetadata.timestamp < CACHE_TTL &&
        !cachedMetadata.error
      ) {
        setUserMetadata((current) => {
          const updated = new Map(current);
          updated.set(event.pubkey, cachedMetadata.data);
          return updated;
        });
      } else {
        // メタデータが必要な場合は非同期で取得
        loadPostMetadata(event.pubkey);
      }
    },
    [debugLog, loadPostMetadata],
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
              relays: DEFAULT_RELAYS,
            },
          };

          updatePostsAndCache(event, post);
        };

        const setupSubscriptions = () => {
          debugLog("Setting up subscriptions");

          const initialFilter = {
            kinds: [1],
            limit: 30,
            since: Math.floor(Date.now() / 1000) - 24 * 60 * 60,
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
                setIsSubscriptionReady(true);
                subscriptionReadyRef.current = true;
                isInitialLoadComplete.current = true;
                // 初期ロード完了後にメタデータ取得を開始
                processBatchMetadataUpdate();
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
              next: ({ event }) => processEvent(event),
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
  }, [debugLog, toast, updatePostsAndCache, processBatchMetadataUpdate]);

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