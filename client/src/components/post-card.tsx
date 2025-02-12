import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Heart, MessageSquare, Share } from "lucide-react";
import { Post } from "@shared/schema";
import { format } from "date-fns";
import { useNostr } from "@/hooks/use-nostr";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";

interface PostCardProps {
  post: Post;
}

export default function PostCard({ post }: PostCardProps) {
  const { getUserMetadata } = useNostr();
  const metadata = getUserMetadata(post.pubkey);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-4">
        <Avatar className="h-10 w-10">
          {metadata?.picture ? (
            <AvatarImage src={metadata.picture} alt={metadata.name || 'User avatar'} />
          ) : (
            <AvatarFallback>
              {(metadata?.name || post.pubkey.slice(0, 2)).toUpperCase()}
            </AvatarFallback>
          )}
        </Avatar>
        <div>
          <p className="font-semibold">
            {metadata?.name || `@${post.pubkey.slice(0, 8)}`}
          </p>
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