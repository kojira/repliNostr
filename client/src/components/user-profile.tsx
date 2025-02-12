import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { User } from "@shared/schema";

interface UserProfileProps {
  user: User;
}

export default function UserProfile({ user }: UserProfileProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-4">
        <Avatar className="h-16 w-16">
          <AvatarFallback>
            {user.username.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div>
          <h2 className="text-xl font-bold">@{user.username}</h2>
          <p className="text-sm text-muted-foreground truncate">
            {user.publicKey}
          </p>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4 text-center">
          <div>
            <p className="font-semibold">Following</p>
            <p className="text-muted-foreground">
              {user.following?.length || 0}
            </p>
          </div>
          <div>
            <p className="font-semibold">Posts</p>
            <p className="text-muted-foreground">0</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
