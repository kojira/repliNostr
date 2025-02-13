import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Heart, MessageSquare, Share, MoreVertical } from "lucide-react";
import { Post } from "@shared/schema";
import { format } from "date-fns";
import { useNostr } from "@/hooks/use-nostr";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { memo, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useInView } from "react-intersection-observer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useLocation } from "wouter";

interface PostCardProps {
  post: Post;
  priority?: boolean;
}

function PostCard({ post, priority = false }: PostCardProps) {
  const { getUserMetadata, loadPostMetadata } = useNostr();
  const [isLoading, setIsLoading] = useState(!priority);
  const [showJson, setShowJson] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [, setLocation] = useLocation();
  const { ref, inView } = useInView({
    threshold: 0,
    triggerOnce: true
  });

  useEffect(() => {
    if (inView) {
      loadPostMetadata(post.pubkey);
    }
  }, [inView, post.pubkey, loadPostMetadata]);

  const metadata = getUserMetadata(post.pubkey);
  const shortPubkey = post.pubkey.slice(0, 8);

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
      <Avatar 
        className="h-10 w-10 cursor-pointer hover:opacity-80 transition-opacity"
        onClick={() => setLocation(`/profile/${post.pubkey}`)}
      >
        {metadata?.picture ? (
          <AvatarImage 
            src={metadata.picture} 
            alt={metadata.name || shortPubkey}
            onError={(e) => {
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

  const handleJsonDialog = () => {
    setShowJson(true);
    setDropdownOpen(false);
  };

  const handleNameClick = () => {
    setLocation(`/profile/${post.pubkey}`);
  };

  return (
    <>
      <Card ref={ref} className={cn(isLoading && "opacity-70")}>
        <CardHeader className="flex flex-row items-center gap-4">
          {renderAvatar()}
          <div className="space-y-1 flex-grow">
            {isLoading ? (
              <Skeleton className="h-4 w-24" />
            ) : (
              <p 
                className="font-semibold cursor-pointer hover:underline"
                onClick={handleNameClick}
              >
                {metadata?.name || `nostr:${shortPubkey}`}
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              {format(new Date(post.createdAt), "yyyy/MM/dd HH:mm:ss")}
            </p>
          </div>
          <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="shrink-0">
                <MoreVertical className="h-4 w-4" />
                <span className="sr-only">メニューを開く</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[140px] w-[140px]">
              <DropdownMenuItem onClick={handleJsonDialog}>
                JSONを確認
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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

      <Dialog open={showJson} onOpenChange={setShowJson}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>投稿データ</DialogTitle>
          </DialogHeader>
          <pre className="bg-muted p-4 rounded-md overflow-auto max-h-[400px]">
            {JSON.stringify(post, null, 2)}
          </pre>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default memo(PostCard);