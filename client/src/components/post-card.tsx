import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Heart, MessageSquare, Share } from "lucide-react";
import { Post } from "@shared/schema";
import { format } from "date-fns";
import { useNostr } from "@/hooks/use-nostr";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { memo, useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface PostCardProps {
  post: Post;
  priority?: boolean;
}

function PostCard({ post, priority = false }: PostCardProps) {
  const { getUserMetadata } = useNostr();
  const [isLoading, setIsLoading] = useState(!priority);
  const metadata = getUserMetadata(post.pubkey);

  // Truncated pubkey for fallback display
  const shortPubkey = post.pubkey.slice(0, 8);

  // メタデータ取得の遅延開始（非優先の場合）
  useEffect(() => {
    if (!priority) {
      const timer = setTimeout(() => {
        setIsLoading(false);
      }, 500);
      return () => clearTimeout(timer);
    }
    setIsLoading(false);
  }, [priority]);

  const renderAvatar = () => {
    if (isLoading) {
      return <Skeleton className="h-10 w-10 rounded-full" />;
    }

    return (
      <Avatar className="h-10 w-10">
        {metadata?.picture ? (
          <AvatarImage 
            src={metadata.picture} 
            alt={metadata.name || shortPubkey}
            onError={(e) => {
              // Remove src on error to show fallback
              (e.target as HTMLImageElement).src = '';
            }}
          />
        ) : (
          <AvatarFallback>
            {(metadata?.name?.[0] || shortPubkey.slice(0, 2)).toUpperCase()}
          </AvatarFallback>
        )}
      </Avatar>
    );
  };

  return (
    <Card className={cn(isLoading && "opacity-70")}>
      <CardHeader className="flex flex-row items-center gap-4">
        {renderAvatar()}
        <div className="space-y-1">
          {isLoading ? (
            <Skeleton className="h-4 w-24" />
          ) : (
            <p className="font-semibold">
              {metadata?.name || `@${shortPubkey}`}
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            {format(new Date(post.createdAt), "PPp")}
          </p>
        </div>
      </CardHeader>
      <CardContent>
        <p className="whitespace-pre-wrap">{post.content}</p>
      </CardContent>
      <CardFooter className="flex gap-4">
        <Button variant="ghost" size="sm">
          <Heart className="h-4 w-4 mr-2" />
          Like
        </Button>
        <Button variant="ghost" size="sm">
          <MessageSquare className="h-4 w-4 mr-2" />
          Reply
        </Button>
        <Button variant="ghost" size="sm">
          <Share className="h-4 w-4 mr-2" />
          Share
        </Button>
      </CardFooter>
    </Card>
  );
}

// Memoize the component to prevent unnecessary re-renders
export default memo(PostCard);