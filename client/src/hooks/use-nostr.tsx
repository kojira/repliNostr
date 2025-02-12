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
const CACHE_TTL = 1000 * 60 * 60 * 3; // 3時間
const MAX_CACHED_METADATA = 1000;
const METADATA_TIMEOUT = 15000; // 15秒でタイムアウト

interface UserMetadata {
  name?: string;
  picture?: string;
  about?: string;
}

const DEFAULT_RELAYS = ["wss://r.kojira.io", "wss://x.kojira.io"];
const DEBUG = true;

// rx-nostrインスタンス管理
let globalRxInstance: RxNostr | null = null;
let globalInitialized = false;
let isProcessingMetadata = false;

// ローカルストレージ操作ユーティリティ
const storage = {
  saveMetadata(
    pubkey: string,
    data: { data: UserMetadata; timestamp: number; error?: string },
  ) {
    try {
      const cache = this.loadAllMetadata();
      cache[pubkey] = data;

      // キャッシュサイズの制限
      const entries = Object.entries(cache);
      if (entries.length > MAX_CACHED_METADATA) {
        const sortedEntries = entries
          .sort(([, a], [, b]) => b.timestamp - a.timestamp)
          .slice(0, MAX_CACHED_METADATA);
        const newCache = Object.fromEntries(sortedEntries);
        localStorage.setItem(METADATA_CACHE_KEY, JSON.stringify(newCache));
      } else {
        localStorage.setItem(METADATA_CACHE_KEY, JSON.stringify(cache));
      }
      localStorage.setItem(METADATA_TIMESTAMP_KEY, Date.now().toString());
    } catch (error) {
      console.error("Error saving metadata to localStorage:", error);
    }
  },

  loadAllMetadata(): Record<
    string,
    { data: UserMetadata; timestamp: number; error?: string }
  > {
    try {
      const cache = localStorage.getItem(METADATA_CACHE_KEY);
      return cache ? JSON.parse(cache) : {};
    } catch (error) {
      console.error("Error loading metadata from localStorage:", error);
      return {};
    }
  },

  loadMetadata(pubkey: string) {
    const cache = this.loadAllMetadata();
    return cache[pubkey];
  },

  // 期限切れのキャッシュを削除し、有効なキャッシュのみを返す
  clearExpiredMetadata() {
    const now = Date.now();
    const cache = this.loadAllMetadata();
    const validEntries = Object.entries(cache).filter(
      ([, value]) => now - value.timestamp < CACHE_TTL && !value.error
    );
    const newCache = Object.fromEntries(validEntries);
    localStorage.setItem(METADATA_CACHE_KEY, JSON.stringify(newCache));
    localStorage.setItem(METADATA_TIMESTAMP_KEY, now.toString());
    return newCache;
  },

  // キャッシュの更新（既存のエントリがある場合は上書き）
  updateMetadata(
    pubkey: string,
    data: UserMetadata,
    error?: string
  ) {
    const cacheEntry = {
      data,
      timestamp: Date.now(),
      error,
    };
    this.saveMetadata(pubkey, cacheEntry);
    return cacheEntry;
  }
};

export function useNostr() {
  const { toast } = useToast();
  const [initialized, setInitialized] = useState(false);
  const [posts, setPosts] = useState<Map<string, Post>>(new Map());
  const [userMetadata, setUserMetadata] = useState<Map<string, UserMetadata>>(
    new Map(),
  );
  const seenEvents = useRef<Set<string>>(new Set());
  const lastEventTimestamp = useRef<number>(0);
  const isInitialLoadComplete = useRef(false);
  const pendingMetadata = useRef<string[]>([]);
  const [isSubscriptionReady, setIsSubscriptionReady] = useState(false);
  const subscriptionReadyRef = useRef(false);

  const debugLog = useCallback((message: string, ...args: any[]) => {
    if (DEBUG) {
      console.log(`[Nostr ${new Date().toISOString()}] ${message}`, ...args);
    }
  }, []);

  // キャッシュの有効性をチェックする関数
  const isValidCache = useCallback((pubkey: string): boolean => {
    const cached = storage.loadMetadata(pubkey);
    return (
      cached &&
      Date.now() - cached.timestamp < CACHE_TTL &&
      !cached.error
    );
  }, []);

  // キャッシュからメタデータを適用する関数
  const applyMetadataFromCache = useCallback((pubkey: string) => {
    const cached = storage.loadMetadata(pubkey);
    if (cached && !cached.error) {
      setUserMetadata((current) => {
        const updated = new Map(current);
        updated.set(pubkey, cached.data);
        return updated;
      });
      return true;
    }
    return false;
  }, []);

  // メタデータ取得の処理 - 1件ずつシリアルに処理
  const processMetadataQueue = useCallback(async () => {
    if (isProcessingMetadata || !pendingMetadata.current.length) {
      return;
    }

    isProcessingMetadata = true;

    try {
      while (pendingMetadata.current.length > 0) {
        const pubkey = pendingMetadata.current[0];

        // キャッシュを再確認
        if (isValidCache(pubkey)) {
          debugLog(`Using cached metadata for ${pubkey}`);
          applyMetadataFromCache(pubkey);
          pendingMetadata.current.shift();
          continue;
        }

        // rx-nostrの準備状態をチェック
        if (!globalRxInstance || !subscriptionReadyRef.current) {
          debugLog(
            `Metadata load skipped: rxInstance=${!!globalRxInstance}, ready=${subscriptionReadyRef.current}`,
          );
          break; // 準備が整っていない場合は処理を中断
        }

        debugLog(`Processing metadata for ${pubkey}`);

        try {
          await new Promise((resolve, reject) => {
            const filter = {
              kinds: [0],
              authors: [pubkey],
            };

            const rxReq = createRxForwardReq();
            let isCompleted = false;

            const timeoutId = setTimeout(() => {
              if (!isCompleted) {
                debugLog(`Metadata request timeout for ${pubkey}`);
                // タイムアウト時はデフォルト値を設定
                const defaultMetadata = {
                  name: `nostr:${pubkey.slice(0, 8)}`,
                };
                const cacheEntry = storage.updateMetadata(
                  pubkey,
                  defaultMetadata,
                  "Metadata fetch timeout"
                );
                setUserMetadata((current) => {
                  const updated = new Map(current);
                  updated.set(pubkey, defaultMetadata);
                  return updated;
                });
                isCompleted = true;
                resolve(undefined);
              }
            }, METADATA_TIMEOUT);

            const subscription = globalRxInstance!.use(rxReq).subscribe({
              next: ({ event }) => {
                try {
                  if (isCompleted) return; // タイムアウト後のレスポンスは無視

                  debugLog(`Received metadata for pubkey: ${event.pubkey}`);
                  const metadata = JSON.parse(event.content) as UserMetadata;
                  const processedMetadata = {
                    name: metadata.name || `nostr:${event.pubkey.slice(0, 8)}`,
                    picture: metadata.picture,
                    about: metadata.about,
                  };

                  // キャッシュを更新
                  storage.updateMetadata(event.pubkey, processedMetadata);

                  setUserMetadata((current) => {
                    const updated = new Map(current);
                    updated.set(event.pubkey, processedMetadata);
                    return updated;
                  });

                  isCompleted = true;
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
                if (!isCompleted) {
                  isCompleted = true;
                  resolve(undefined);
                }
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
        }

        // 処理が完了したらキューから削除
        pendingMetadata.current.shift();
      }
    } finally {
      isProcessingMetadata = false;
    }
  }, [debugLog, isValidCache, applyMetadataFromCache]);

  // メタデータ取得の公開インターフェース
  const loadPostMetadata = useCallback(
    (pubkey: string) => {
      // キャッシュをチェック
      if (isValidCache(pubkey)) {
        debugLog(`Using cached metadata for ${pubkey}`);
        applyMetadataFromCache(pubkey);
        return;
      }

      // キューに追加（重複を避ける）
      if (!pendingMetadata.current.includes(pubkey)) {
        pendingMetadata.current.push(pubkey);
        // キューの処理を開始
        processMetadataQueue().catch((error) =>
          debugLog("Error processing metadata queue:", error),
        );
      }
    },
    [debugLog, isValidCache, applyMetadataFromCache, processMetadataQueue],
  );

  // イベントとキャッシュの更新
  const updatePostsAndCache = useCallback(
    (event: any, post: Post) => {
      setPosts((currentPosts) => {
        const updatedPosts = new Map(currentPosts);
        updatedPosts.set(event.id, post);
        return updatedPosts;
      });

      // キャッシュされたメタデータがあれば即座に適用し、なければキューに追加
      if (isValidCache(event.pubkey)) {
        debugLog(`Using cached metadata for ${event.pubkey}`);
        applyMetadataFromCache(event.pubkey);
      } else if (!pendingMetadata.current.includes(event.pubkey)) {
        pendingMetadata.current.push(event.pubkey);
        // キューの処理を開始
        processMetadataQueue().catch((error) =>
          debugLog("Error processing metadata queue:", error),
        );
      }
    },
    [debugLog, isValidCache, applyMetadataFromCache, processMetadataQueue],
  );

  // 初期化時にローカルストレージからキャッシュを読み込む
  useEffect(() => {
    // 期限切れのキャッシュをクリア
    const validCache = storage.clearExpiredMetadata();

    // メタデータを初期化
    Object.entries(validCache).forEach(([pubkey, value]) => {
      if (!value.error) {
        setUserMetadata((current) => {
          const updated = new Map(current);
          updated.set(pubkey, value.data);
          return updated;
        });
      }
    });
  }, []);

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

        debugLog("Setting up subscriptions");
        const setupSubscriptions = () => {
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

  return {
    posts: Array.from(posts.values()).sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    ),
    isLoadingPosts: !initialized,
    getUserMetadata: useCallback(
      (pubkey: string) => userMetadata.get(pubkey),
      [userMetadata],
    ),
    loadPostMetadata,
  };
}