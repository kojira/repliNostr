import { useMutation } from "@tanstack/react-query";
import { Post } from "@shared/schema";
import { useToast } from "./use-toast";
import { createRxNostr, createRxForwardReq } from 'rx-nostr';
import { verifier } from 'rx-nostr-crypto';
import { bytesToHex } from '@noble/hashes/utils';
import { useEffect, useRef, useState, useCallback } from "react";
import type { RxNostr } from 'rx-nostr';

const METADATA_CACHE_KEY = 'nostr_metadata_cache';
const METADATA_TIMESTAMP_KEY = 'nostr_metadata_timestamp';
const EVENTS_CACHE_KEY = 'nostr_events_cache';
const EVENTS_TIMESTAMP_KEY = 'nostr_events_timestamp';
const CACHE_TTL = 1000 * 60 * 60 * 3; // 3時間
const EVENTS_CACHE_TTL = 1000 * 60 * 5; // 5分
const MAX_CACHED_METADATA = 1000;
const MAX_CACHED_EVENTS = 100;
const METADATA_BATCH_SIZE = 10; // 一度に処理するメタデータの数
const METADATA_REQUEST_INTERVAL = 1000; // メタデータリクエスト間隔（ミリ秒）
const MAX_RETRIES = 3; // 最大リトライ回数

// メモリ内キャッシュ
const metadataMemoryCache = new Map<string, { data: UserMetadata; timestamp: number; error?: string }>();
const eventsMemoryCache = new Map<string, { data: Post; timestamp: number }>();
const metadataRequestTimes = new Map<string, number>(); // リクエスト時刻を追跡

// rx-nostrインスタンス管理（変更なし）
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
  const DEBUG = true;

  const debugLog = useCallback((message: string, ...args: any[]) => {
    if (DEBUG) {
      console.log(`[Nostr] ${message}`, ...args);
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
      debugLog(`Pruned metadata cache to ${MAX_CACHED_METADATA} entries`);
    }
  }, [debugLog]);

  // メタデータ更新の最適化されたバッチ処理
  const processBatchMetadataUpdate = useCallback(() => {
    if (!globalRxInstance || metadataUpdateQueue.current.size === 0 || !isSubscriptionReady) {
      return;
    }

    const now = Date.now();
    if (now - lastMetadataRequest.current < METADATA_REQUEST_INTERVAL) {
      return;
    }

    // キューから未処理のpubkeyを取得（最大METADATA_BATCH_SIZE件）
    const pubkeysToProcess = Array.from(metadataUpdateQueue.current)
      .filter(pubkey => !pendingMetadataRequests.current.has(pubkey))
      .slice(0, METADATA_BATCH_SIZE);

    if (pubkeysToProcess.length === 0) {
      return;
    }

    debugLog(`Processing metadata batch for ${pubkeysToProcess.length} pubkeys`);
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

    const rxReq = createRxForwardReq();
    const timeoutMs = 10000; // タイムアウトを10秒に延長

    const timeoutId = setTimeout(() => {
      debugLog(`Batch metadata request timeout for ${pubkeysToProcess.length} pubkeys`);
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

      if (metadataUpdateQueue.current.size > 0) {
        setTimeout(processBatchMetadataUpdate, METADATA_REQUEST_INTERVAL);
      }
    }, timeoutMs);

    const subscription = globalRxInstance
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
              const updated = new Map(current);
              updated.set(event.pubkey, processedMetadata);
              return updated;
            });

            pendingMetadataRequests.current.delete(event.pubkey);
            retryCount.current.delete(event.pubkey);
            debugLog(`Successfully processed metadata for ${event.pubkey}`);
          } catch (error) {
            debugLog(`Error processing metadata for ${event.pubkey}:`, error);
            const currentRetries = retryCount.current.get(event.pubkey) || 0;
            if (currentRetries < MAX_RETRIES) {
              metadataUpdateQueue.current.add(event.pubkey);
              retryCount.current.set(event.pubkey, currentRetries + 1);
            }
            pendingMetadataRequests.current.delete(event.pubkey);
          }
        },
        error: (error) => {
          debugLog(`Batch metadata request error:`, error);
          pubkeysToProcess.forEach(pubkey => {
            const currentRetries = retryCount.current.get(pubkey) || 0;
            if (currentRetries < MAX_RETRIES) {
              metadataUpdateQueue.current.add(pubkey);
              retryCount.current.set(pubkey, currentRetries + 1);
            }
            pendingMetadataRequests.current.delete(pubkey);
          });
        },
        complete: () => {
          debugLog(`Batch metadata request completed`);
          clearTimeout(timeoutId);

          // 次のバッチ処理をスケジュール
          if (metadataUpdateQueue.current.size > 0) {
            setTimeout(processBatchMetadataUpdate, METADATA_REQUEST_INTERVAL);
          }
        }
      });

    rxReq.emit(filter);
    debugLog(`Emitted filter for batch subscription`);

    return () => {
      subscription.unsubscribe();
      clearTimeout(timeoutId);
    };
  }, [isSubscriptionReady, debugLog]);

  // 最適化されたメタデータ取得インターフェース
  const loadPostMetadata = useCallback((pubkey: string) => {
    if (!globalRxInstance || !isSubscriptionReady) {
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
      debugLog(`Queueing metadata request for ${pubkey}`);

      // キューが追加されたらバッチ処理をスケジュール
      setTimeout(processBatchMetadataUpdate, METADATA_REQUEST_INTERVAL);
    }
  }, [isSubscriptionReady, processBatchMetadataUpdate, debugLog]);

  const updatePostsAndCache = useCallback((event: any, post: Post) => {
    eventsMemoryCache.set(event.id, {
      data: post,
      timestamp: Date.now()
    });

    // メモリキャッシュを最新100件に制限
    const sortedEvents = Array.from(eventsMemoryCache.entries())
      .sort(([, a], [, b]) => new Date(b.data.createdAt).getTime() - new Date(a.data.createdAt).getTime())
      .slice(0, MAX_CACHED_EVENTS);

    eventsMemoryCache.clear();
    sortedEvents.forEach(([id, data]) => eventsMemoryCache.set(id, data));

    setPosts(currentPosts => {
      const updatedPosts = new Map(currentPosts);
      updatedPosts.set(event.id, post);

      // 投稿も最新100件に制限
      const sortedPosts = Array.from(updatedPosts.entries())
        .sort(([, a], [, b]) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, MAX_CACHED_EVENTS);

      return new Map(sortedPosts);
    });

    // メタデータ取得を試みる
    loadPostMetadata(event.pubkey);
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
          debugLog(`Saved ${sortedPosts.length} events to cache`);
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
          setPosts(new Map(entries.map(([key, value]) => [key, value as Post])));
          debugLog(`Loaded ${entries.length} events from cache`);

          // メタデータの処理を最適化
          const uniquePubkeys = new Set(entries.map(([_, post]) => (post as Post).pubkey));
          debugLog(`Processing metadata for ${uniquePubkeys.size} unique pubkeys from cache`);

          // すでにメタデータが存在するpubkeyを除外
          const pubkeysToProcess = Array.from(uniquePubkeys).filter(pubkey => {
            const memCached = metadataMemoryCache.get(pubkey);
            return !(memCached && (Date.now() - memCached.timestamp < CACHE_TTL));
          });

          if (pubkeysToProcess.length > 0) {
            debugLog(`Requesting metadata for ${pubkeysToProcess.length} new pubkeys`);
            pubkeysToProcess.forEach(pubkey => {
              loadPostMetadata(pubkey);
            });
          }
        }
      }
    } catch (error) {
      debugLog('Error loading events cache:', error);
    }
  }, [loadPostMetadata, debugLog]);

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
        debugLog("Initializing rx-nostr");
        if (!globalRxInstance) {
          globalRxInstance = createRxNostr({ verifier });
          globalRxInstance.setDefaultRelays(DEFAULT_RELAYS);
          globalInitialized = true;
        }
        setInitialized(true);

        // イベント処理の共通関数
        const processEvent = (event: any) => {
          if (seenEvents.current.has(event.id)) {
            debugLog(`Skipping duplicate event: ${event.id}`);
            return;
          }

          seenEvents.current.add(event.id);
          debugLog(`Processing event: ${event.id}`);

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

          debugLog("Fetching initial events with filter:", initialFilter);

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

          // リアルタイム更新用のサブスクリプション
          const continuousFilter = {
            kinds: [1],
            since: Math.floor(Date.now() / 1000)
          };

          debugLog("Setting up continuous subscription with filter:", continuousFilter);

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
            debugLog("Cleaned up all subscriptions");
          };
        };

        // サブスクリプションの準備が整ったことを通知
        setIsSubscriptionReady(true);

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
        loadPostMetadata(pubkey);
      }
      return userMetadata.get(pubkey);
    }, [userMetadata, loadPostMetadata]),
    loadPostMetadata
  };
}