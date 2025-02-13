import { useMutation } from "@tanstack/react-query";
import { Post } from "@shared/schema";
import { useToast } from "./use-toast";
import { createRxNostr, createRxForwardReq, nip07Signer } from "rx-nostr";
import { verifier, seckeySigner } from "rx-nostr-crypto";
import { useEffect, useRef, useState, useCallback } from "react";
import { useAuth } from "./use-auth";

// Define custom Event type to match rx-nostr's event structure
interface NostrEvent {
  id?: string;
  pubkey?: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig?: string;
}

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
  const { user } = useAuth();
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
  const previousUserRef = useRef(user);
  const [following, setFollowing] = useState<Set<string>>(new Set());

  const debugLog = useCallback((message: string, ...args: any[]) => {
    if (DEBUG) {
      console.log(`[Nostr ${new Date().toISOString()}] ${message}`, ...args);
    }
  }, []);

  // rx-nostrインスタンスのリセット処理
  const resetNostrInstance = useCallback(() => {
    debugLog("Resetting rx-nostr instance");
    globalRxInstance = null;
    globalInitialized = false;
    setInitialized(false);
    setIsSubscriptionReady(false);
    subscriptionReadyRef.current = false;
    isInitialLoadComplete.current = false;
    seenEvents.current.clear();
    setPosts(new Map());
    setFollowing(new Set());
  }, [debugLog]);

  // ユーザー変更の監視
  useEffect(() => {
    if (user?.publicKey !== previousUserRef.current?.publicKey) {
      debugLog("User changed, resetting Nostr client");
      resetNostrInstance();
    }
    previousUserRef.current = user;
  }, [user, resetNostrInstance, debugLog]);

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
    debugLog("Starting metadata queue processing");

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
          break;
        }

        debugLog(`Requesting metadata for ${pubkey}`);

        try {
          await new Promise((resolve, reject) => {
            const filter = {
              kinds: [0],
              authors: [pubkey],
              limit: 1,
            };

            const rxReq = createRxForwardReq();
            let isCompleted = false;

            const timeoutId = setTimeout(() => {
              if (!isCompleted) {
                debugLog(`Metadata request timeout for ${pubkey}`);
                const defaultMetadata = {
                  name: `nostr:${pubkey.slice(0, 8)}`,
                  picture: undefined,
                };
                storage.updateMetadata(pubkey, defaultMetadata, "Timeout");
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
                if (isCompleted) return;

                try {
                  debugLog(`Received metadata for ${event.pubkey}`);
                  const metadata = JSON.parse(event.content) as UserMetadata;

                  if (!metadata) {
                    throw new Error("Invalid metadata format");
                  }

                  const processedMetadata = {
                    name: metadata.name || `nostr:${event.pubkey.slice(0, 8)}`,
                    picture: metadata.picture,
                    about: metadata.about,
                  };

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
                debugLog("Metadata subscription error:", error);
                reject(error);
              },
              complete: () => {
                if (!isCompleted) {
                  debugLog(`No metadata found for ${pubkey}`);
                  const defaultMetadata = {
                    name: `nostr:${pubkey.slice(0, 8)}`,
                    picture: undefined,
                  };
                  storage.updateMetadata(pubkey, defaultMetadata, "Not found");
                  setUserMetadata((current) => {
                    const updated = new Map(current);
                    updated.set(pubkey, defaultMetadata);
                    return updated;
                  });
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

        pendingMetadata.current.shift();
        await new Promise(resolve => setTimeout(resolve, 100)); // Rate limiting
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
    (event: NostrEvent, post: Post) => {
      // イベントIDが存在し、署名が存在する場合のみ投稿を追加
      if (event.id && event.sig) {
        setPosts((currentPosts) => {
          const updatedPosts = new Map(currentPosts);
          // イベントIDをキーとして使用して重複を防ぐ
          if (!updatedPosts.has(event.id)) {
            updatedPosts.set(event.id, post);
            debugLog(`Added new post with id: ${event.id}`);
          }
          return updatedPosts;
        });

        // キャッシュされたメタデータがあれば即座に適用し、なければキューに追加
        if (isValidCache(event.pubkey!)) {
          debugLog(`Using cached metadata for ${event.pubkey}`);
          applyMetadataFromCache(event.pubkey!);
        } else if (!pendingMetadata.current.includes(event.pubkey!)) {
          pendingMetadata.current.push(event.pubkey!);
          processMetadataQueue().catch((error) =>
            debugLog("Error processing metadata queue:", error),
          );
        }
      } else {
        debugLog("Skipping invalid event without id or signature");
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
    if (globalInitialized && initialized) {
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
          if (!user) {
            debugLog("No user available, initializing without signer");
            globalRxInstance = createRxNostr({ verifier });
          } else if (user.type === "extension") {
            debugLog("Initializing with NIP-07 signer");
            globalRxInstance = createRxNostr({
              verifier,
              signer: nip07Signer()
            });
          } else if (user.type === "generated" && user.privateKey) {
            debugLog("Initializing with private key signer");
            globalRxInstance = createRxNostr({
              verifier,
              signer: seckeySigner(user.privateKey)
            });
          } else {
            throw new Error("Invalid user configuration");
          }
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
                    nostrEventId: event.id!,
                    pubkey: event.pubkey!,
                    signature: event.sig!,
                    metadata: {
                      tags: event.tags || [],
                      relays: DEFAULT_RELAYS,
                    },
                  };
                  updatePostsAndCache(event, post);
                  initialEventsReceived++;
                  debugLog(`Received initial event: ${event.id}`);
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
                    nostrEventId: event.id!,
                    pubkey: event.pubkey!,
                    signature: event.sig!,
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
  }, [debugLog, toast, updatePostsAndCache, user, initialized]);

  // Create post mutation
  const createPostMutation = useMutation({
    mutationFn: async (content: string) => {
      if (!user || !globalRxInstance) {
        throw new Error("Not ready to post");
      }

      debugLog("Creating new post event");
      const event = {
        kind: 1,
        content,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
      };

      debugLog("Sending signed post with content:", content);

      return new Promise<Post>((resolve, reject) => {
        let successCount = 0;
        let failureCount = 0;
        const totalRelays = DEFAULT_RELAYS.length;

        globalRxInstance!.send(event).subscribe({
          next: (packet) => {
            debugLog(`Relay response from ${packet.from}:`, packet);
            if (packet.ok) {
              debugLog(`Post sent successfully to ${packet.from}`);
              successCount++;

              const post: Post = {
                id: 0,
                userId: 0,
                content: event.content,
                createdAt: new Date(event.created_at * 1000).toISOString(),
                nostrEventId: event.id,
                pubkey: event.pubkey,
                signature: event.sig,
                metadata: {
                  tags: event.tags,
                  relays: DEFAULT_RELAYS,
                },
              };

              if (successCount === 1) {
                resolve(post);
              }
            } else {
              debugLog(`Failed to send post to ${packet.from}`);
              failureCount++;
            }

            if (successCount + failureCount === totalRelays) {
              debugLog(`Post sending completed. Success: ${successCount}, Failed: ${failureCount}`);
              if (successCount === 0) {
                reject(new Error("Failed to send to all relays"));
              }
            }
          },
          error: (error) => {
            debugLog("Error sending post:", error);
            reject(error);
          },
        });
      });
    },
    onSuccess: (post) => {
      if (post.nostrEventId && post.signature) {
        setPosts((currentPosts) => {
          const updatedPosts = new Map(currentPosts);
          updatedPosts.set(post.nostrEventId, post);
          return updatedPosts;
        });
        toast({
          title: "成功",
          description: "投稿を送信しました",
        });
      }
    },
    onError: (error) => {
      console.error("Error creating post:", error);
      toast({
        title: "エラー",
        description: "投稿に失敗しました",
        variant: "destructive",
      });
    },
  });

  // Add updateProfile mutation
  const updateProfileMutation = useMutation({
    mutationFn: async (metadata: { name?: string; about?: string; picture?: string }) => {
      if (!user || !globalRxInstance) {
        throw new Error("Not ready to update profile");
      }

      debugLog("Creating profile update event");
      const event = {
        kind: 0,
        content: JSON.stringify(metadata),
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
      };

      debugLog("Sending signed profile update with content:", metadata);

      return new Promise<void>((resolve, reject) => {
        let successCount = 0;
        let failureCount = 0;
        const totalRelays = DEFAULT_RELAYS.length;

        globalRxInstance!.send(event).subscribe({
          next: (packet) => {
            debugLog(`Relay response from ${packet.from}:`, packet);
            if (packet.ok) {
              debugLog(`Profile update sent successfully to ${packet.from}`);
              successCount++;

              if (successCount === 1) {
                // Update local metadata cache
                setUserMetadata((current) => {
                  const updated = new Map(current);
                  if (user) {
                    updated.set(user.publicKey, {
                      ...metadata,
                    });
                  }
                  return updated;
                });

                // Update localStorage cache
                if (user) {
                  storage.updateMetadata(user.publicKey, metadata);
                }

                resolve();
              }
            } else {
              debugLog(`Failed to send profile update to ${packet.from}`);
              failureCount++;
            }

            if (successCount + failureCount === totalRelays) {
              debugLog(`Profile update completed. Success: ${successCount}, Failed: ${failureCount}`);
              if (successCount === 0) {
                reject(new Error("Failed to send to all relays"));
              }
            }
          },
          error: (error) => {
            debugLog("Error sending profile update:", error);
            reject(error);
          },
        });
      });
    },
    onSuccess: () => {
      toast({
        title: "成功",
        description: "プロフィールを更新しました",
      });
    },
    onError: (error) => {
      console.error("Error updating profile:", error);
      toast({
        title: "エラー",
        description: "プロフィールの更新に失敗しました",
        variant: "destructive",
      });
    },
  });

  // Nostrのkind定義
  const KIND = {
    METADATA: 0,
    TEXT_NOTE: 1,
    CONTACT_LIST: 3,
  } as const;

  // フォロー状態の管理
  interface Contact {
    pubkey: string;
    relayUrl?: string;
    petname?: string;
  }

  // フォロー状態の取得
  const loadFollowingList = useCallback(async () => {
    if (!user || !globalRxInstance) return;

    debugLog("Loading following list");
    const filter = {
      kinds: [KIND.CONTACT_LIST],
      authors: [user.publicKey],
    };

    return new Promise<void>((resolve, reject) => {
      const rxReq = createRxForwardReq();
      let hasReceivedList = false;

      const subscription = globalRxInstance.use(rxReq).subscribe({
        next: ({ event }) => {
          if (hasReceivedList) return;

          try {
            const contacts: Contact[] = event.tags
              .filter(tag => tag[0] === 'p')
              .map(tag => ({
                pubkey: tag[1],
                relayUrl: tag[2],
                petname: tag[3],
              }));

            setFollowing(new Set(contacts.map(contact => contact.pubkey)));
            hasReceivedList = true;
            resolve();
          } catch (error) {
            debugLog("Error processing contact list:", error);
            reject(error);
          }
        },
        error: (error) => {
          debugLog("Error loading following list:", error);
          reject(error);
        },
        complete: () => {
          if (!hasReceivedList) {
            debugLog("No contact list found");
            resolve();
          }
        },
      });

      rxReq.emit(filter);

      return () => subscription.unsubscribe();
    });
  }, [user, debugLog]);

  // フォロー/アンフォロー機能
  const toggleFollowMutation = useMutation({
    mutationFn: async (targetPubkey: string) => {
      if (!user || !globalRxInstance) {
        throw new Error("Not ready to update follows");
      }

      const isFollowing = following.has(targetPubkey);
      const newFollowList = isFollowing
        ? Array.from(following).filter(key => key !== targetPubkey)
        : [...Array.from(following), targetPubkey];

      const tags = newFollowList.map(pubkey => ['p', pubkey]);

      const event = {
        kind: KIND.CONTACT_LIST,
        content: '',
        tags,
        created_at: Math.floor(Date.now() / 1000),
      };

      debugLog(`${isFollowing ? 'Unfollowing' : 'Following'} ${targetPubkey}`);

      return new Promise<void>((resolve, reject) => {
        let successCount = 0;
        let failureCount = 0;
        const totalRelays = DEFAULT_RELAYS.length;

        globalRxInstance!.send(event).subscribe({
          next: (packet) => {
            debugLog(`Relay response from ${packet.from}:`, packet);
            if (packet.ok) {
              debugLog(`Follow update sent successfully to ${packet.from}`);
              successCount++;

              if (successCount === 1) {
                setFollowing(new Set(newFollowList));
                resolve();
              }
            } else {
              debugLog(`Failed to send follow update to ${packet.from}`);
              failureCount++;
            }

            if (successCount + failureCount === totalRelays) {
              debugLog(`Follow update completed. Success: ${successCount}, Failed: ${failureCount}`);
              if (successCount === 0) {
                reject(new Error("Failed to send to all relays"));
              }
            }
          },
          error: (error) => {
            debugLog("Error sending follow update:", error);
            reject(error);
          },
        });
      });
    },
    onSuccess: () => {
      toast({
        title: "成功",
        description: "フォロー状態を更新しました",
      });
    },
    onError: (error) => {
      console.error("Error updating follow status:", error);
      toast({
        title: "エラー",
        description: "フォロー状態の更新に失敗しました",
        variant: "destructive",
      });
    },
  });

  // useEffect hook for loading following list
  useEffect(() => {
    if (user && initialized && isSubscriptionReady) {
      loadFollowingList().catch(error => {
        console.error("Error loading following list:", error);
      });
    }
  }, [user, initialized, isSubscriptionReady, loadFollowingList]);

  interface FetchUserPostsOptions {
    pubkey: string;
    since?: number;
    until?: number;
    limit?: number;
    search?: string;
  }

  // Add to the useNostr hook
  const fetchUserPosts = useCallback(async ({
    pubkey,
    since,
    until,
    limit = 30,
    search
  }: FetchUserPostsOptions) => {
    if (!globalRxInstance || !subscriptionReadyRef.current) {
      throw new Error("Nostr client not ready");
    }

    debugLog(`Fetching posts for user ${pubkey}`);
    const filter = {
      kinds: [KIND.TEXT_NOTE],
      authors: [pubkey],
      limit,
      ...(since && { since }),
      ...(until && { until }),
    };

    return new Promise<Post[]>((resolve, reject) => {
      const posts: Post[] = [];
      const rxReq = createRxForwardReq();
      let receivedCount = 0;
      const timeoutId = setTimeout(() => {
        if (receivedCount === 0) {
          resolve([]); // Return empty array if no posts received
        }
      }, 10000); // 10 second timeout

      const subscription = globalRxInstance.use(rxReq).subscribe({
        next: ({ event }: { event: NostrEvent }) => {
          // If search is provided, filter by content
          if (search && !event.content.toLowerCase().includes(search.toLowerCase())) {
            return;
          }

          if (event.id && event.sig) {
            receivedCount++;
            const post: Post = {
              id: 0,
              userId: 0,
              content: event.content,
              createdAt: new Date(event.created_at * 1000).toISOString(),
              nostrEventId: event.id,
              pubkey: event.pubkey!,
              signature: event.sig,
              metadata: {
                tags: event.tags || [],
                relays: DEFAULT_RELAYS,
              },
            };
            posts.push(post);
          }
        },
        error: (error) => {
          debugLog("Error fetching user posts:", error);
          clearTimeout(timeoutId);
          reject(error);
        },
        complete: () => {
          clearTimeout(timeoutId);
          debugLog(`Fetched ${posts.length} posts for user ${pubkey}`);
          // Sort posts by timestamp before returning
          posts.sort((a, b) => 
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          );
          resolve(posts);
        },
      });

      rxReq.emit(filter);

      return () => {
        subscription.unsubscribe();
        clearTimeout(timeoutId);
      };
    });
  }, [debugLog]);


  return {
    posts: Array.from(posts.values()).sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    ),
    isLoadingPosts: !initialized || !isSubscriptionReady,
    getUserMetadata: useCallback(
      (pubkey: string) => userMetadata.get(pubkey),
      [userMetadata],
    ),
    loadPostMetadata,
    createPost: createPostMutation.mutate,
    isCreatingPost: createPostMutation.isPending,
    updateProfile: updateProfileMutation.mutate,
    isUpdatingProfile: updateProfileMutation.isPending,
    isFollowing: useCallback((pubkey: string) => following.has(pubkey), [following]),
    toggleFollow: toggleFollowMutation.mutate,
    isTogglingFollow: toggleFollowMutation.isPending,
    fetchUserPosts,
  };
}