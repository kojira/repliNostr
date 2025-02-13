import { useParams } from "wouter";
import { useNostr } from "@/hooks/use-nostr";
import { useEffect, useState, useRef, useCallback } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import PostCard from "@/components/post-card";
import { Post } from "@shared/schema";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useInView } from "react-intersection-observer";
import debounce from "lodash/debounce";

export default function ProfilePage() {
  const { pubkey } = useParams<{ pubkey: string }>();

  console.log('[ProfilePage] Rendered with params:', {
    pubkey,
    currentPath: window.location.pathname,
    currentUrl: window.location.href
  });

  const { 
    getUserMetadata, 
    loadPostMetadata, 
    fetchUserPosts, 
    isFollowing, 
    toggleFollow, 
    isTogglingFollow 
  } = useNostr();
  const { user } = useAuth();
  const [posts, setPosts] = useState<Post[]>([]);
  const [isLoadingPosts, setIsLoadingPosts] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const lastTimestamp = useRef<number>();
  const [hasMore, setHasMore] = useState(true);
  const searchTimeoutRef = useRef<NodeJS.Timeout>();

  // 無限スクロール用のintersection observer
  const { ref: loadMoreRef, inView } = useInView({
    threshold: 0,
  });

  // 検索処理
  const handleSearch = useCallback(
    debounce(async (term: string) => {
      if (!pubkey) return;
      setIsSearching(true);
      try {
        const searchResults = await fetchUserPosts({
          pubkey,
          search: term,
          limit: 30,
        });
        setPosts(searchResults);
        setHasMore(searchResults.length === 30);
        lastTimestamp.current = Math.floor(Date.now() / 1000);
      } catch (error) {
        console.error("Search failed:", error);
      } finally {
        setIsSearching(false);
      }
    }, 500),
    [pubkey, fetchUserPosts]
  );

  // 初期投稿の読み込み
  useEffect(() => {
    if (!pubkey) return;

    const loadInitialPosts = async () => {
      setIsLoadingPosts(true);
      try {
        const initialPosts = await fetchUserPosts({
          pubkey,
          limit: 30,
        });
        console.info(`[Profile] Loaded ${initialPosts.length} initial posts for user ${pubkey}`);
        setPosts(initialPosts);
        setHasMore(initialPosts.length === 30);
        if (initialPosts.length > 0) {
          const oldestPost = initialPosts[initialPosts.length - 1];
          lastTimestamp.current = Math.floor(new Date(oldestPost.createdAt).getTime() / 1000);
          console.info(`[Profile] Set last timestamp to ${new Date(oldestPost.createdAt).toISOString()}`);
        }
      } catch (error) {
        console.error("[Profile] Failed to load initial posts:", error);
      } finally {
        setIsLoadingPosts(false);
      }
    };

    loadInitialPosts();
  }, [pubkey, fetchUserPosts]);

  // メタデータの読み込み
  useEffect(() => {
    if (pubkey) {
      loadPostMetadata(pubkey);
    }
  }, [pubkey, loadPostMetadata]);

  // 無限スクロール
  useEffect(() => {
    if (inView && !isLoadingPosts && hasMore && !searchTerm && lastTimestamp.current) {
      const loadMorePosts = async () => {
        setIsLoadingPosts(true);
        try {
          console.info(`[Profile] Loading more posts before timestamp ${new Date(lastTimestamp.current! * 1000).toISOString()}`);
          const morePosts = await fetchUserPosts({
            pubkey: pubkey!,
            until: lastTimestamp.current,
            limit: 30,
          });

          if (morePosts.length > 0) {
            console.info(`[Profile] Loaded ${morePosts.length} more posts`);
            setPosts(prev => [...prev, ...morePosts]);
            const oldestPost = morePosts[morePosts.length - 1];
            lastTimestamp.current = Math.floor(new Date(oldestPost.createdAt).getTime() / 1000);
            console.info(`[Profile] Updated last timestamp to ${new Date(oldestPost.createdAt).toISOString()}`);
          } else {
            console.info('[Profile] No more posts available');
          }
          setHasMore(morePosts.length === 30);
        } catch (error) {
          console.error("[Profile] Failed to load more posts:", error);
        } finally {
          setIsLoadingPosts(false);
        }
      };

      loadMorePosts();
    }
  }, [inView, isLoadingPosts, hasMore, pubkey, fetchUserPosts, searchTerm]);

  // 検索入力の処理
  const handleSearchInput = (value: string) => {
    setSearchTerm(value);
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }
    if (value) {
      handleSearch(value);
    } else {
      // 検索がクリアされた場合、初期状態に戻す
      const resetPosts = async () => {
        setIsLoadingPosts(true);
        try {
          const initialPosts = await fetchUserPosts({
            pubkey: pubkey!,
            limit: 30,
          });
          setPosts(initialPosts);
          setHasMore(initialPosts.length === 30);
          if (initialPosts.length > 0) {
            const oldestPost = initialPosts[initialPosts.length - 1];
            lastTimestamp.current = Math.floor(new Date(oldestPost.createdAt).getTime() / 1000);
          }
        } catch (error) {
          console.error("Failed to reset posts:", error);
        } finally {
          setIsLoadingPosts(false);
        }
      };
      resetPosts();
    }
  };

  const metadata = getUserMetadata(pubkey);
  const shortPubkey = pubkey?.slice(0, 8);

  if (!pubkey) {
    console.log('[ProfilePage] No pubkey provided, returning null');
    return null;
  }

  return (
    <div className="container mx-auto px-4 py-6 space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center gap-4">
          <Avatar className="h-20 w-20">
            {metadata?.picture ? (
              <AvatarImage
                src={metadata.picture}
                alt={metadata?.name || shortPubkey}
                onError={(e) => {
                  (e.target as HTMLImageElement).src = "";
                }}
              />
            ) : (
              <AvatarFallback className="text-lg">
                {(metadata?.name?.[0] || shortPubkey?.slice(0, 2)).toUpperCase()}
              </AvatarFallback>
            )}
          </Avatar>
          <div className="flex-grow">
            <h1 className="text-2xl font-bold">
              {metadata?.name || `nostr:${shortPubkey}`}
            </h1>
            <p className="text-sm text-muted-foreground break-all">
              {pubkey}
            </p>
            {metadata?.about && (
              <p className="mt-2 whitespace-pre-wrap">{metadata.about}</p>
            )}
          </div>
          {user?.publicKey !== pubkey && (
            <Button 
              variant="outline" 
              onClick={() => toggleFollow(pubkey)}
              disabled={isTogglingFollow}
            >
              {isFollowing(pubkey) ? 'フォロー解除' : 'フォロー'}
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {metadata && Object.entries(metadata)
            .filter(([key]) => !["name", "picture", "about"].includes(key))
            .map(([key, value]) => (
              <div key={key} className="flex flex-col">
                <span className="text-sm font-medium">{key}</span>
                <span className="text-sm text-muted-foreground break-all">
                  {typeof value === "string" ? value : JSON.stringify(value)}
                </span>
              </div>
            ))}
        </CardContent>
      </Card>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">投稿</h2>
          <div className="relative max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="投稿を検索..."
              className="pl-8"
              value={searchTerm}
              onChange={(e) => handleSearchInput(e.target.value)}
            />
          </div>
        </div>

        {(isLoadingPosts || isSearching) && posts.length === 0 ? (
          <div className="space-y-4">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-32" />
            ))}
          </div>
        ) : (
          <>
            <div className="space-y-4">
              {posts.map((post) => (
                <PostCard key={post.nostrEventId} post={post} />
              ))}
            </div>
            {hasMore && !searchTerm && (
              <div ref={loadMoreRef} className="py-4">
                {isLoadingPosts && (
                  <div className="space-y-4">
                    {[...Array(2)].map((_, i) => (
                      <Skeleton key={i} className="h-32" />
                    ))}
                  </div>
                )}
              </div>
            )}
            {!hasMore && posts.length > 0 && (
              <p className="text-center text-muted-foreground py-4">
                これ以上の投稿はありません
              </p>
            )}
            {posts.length === 0 && !isLoadingPosts && !isSearching && (
              <p className="text-center text-muted-foreground py-4">
                投稿が見つかりません
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}