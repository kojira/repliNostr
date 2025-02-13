import { useParams } from "wouter";
import { useNostr } from "@/hooks/use-nostr";
import { useEffect } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import PostCard from "@/components/post-card";

export default function ProfilePage() {
  const { pubkey } = useParams<{ pubkey: string }>();
  const { getUserMetadata, loadPostMetadata, posts, isLoadingPosts } = useNostr();
  const { user } = useAuth();

  useEffect(() => {
    if (pubkey) {
      loadPostMetadata(pubkey);
    }
  }, [pubkey, loadPostMetadata]);

  const metadata = getUserMetadata(pubkey);
  const userPosts = posts.filter(post => post.pubkey === pubkey);
  const shortPubkey = pubkey?.slice(0, 8);

  if (!pubkey) return null;

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
            <Button variant="outline">
              フォロー
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
        <h2 className="text-xl font-semibold">投稿</h2>
        {isLoadingPosts ? (
          <div className="space-y-4">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-32" />
            ))}
          </div>
        ) : (
          userPosts.map((post) => (
            <PostCard key={post.nostrEventId} post={post} />
          ))
        )}
      </div>
    </div>
  );
}
