import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { User } from "@shared/schema";
import { useAuth } from "@/hooks/use-auth";
import { useState } from "react";
import RelaySettings from "./relay-settings";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface UserProfileProps {
  user: User;
}

export default function UserProfile({ user }: UserProfileProps) {
  const { loginMutation } = useAuth();
  const [isSavingRelays, setIsSavingRelays] = useState(false);

  const handleSaveRelays = async (relays: User['relays']) => {
    setIsSavingRelays(true);
    try {
      await apiRequest("POST", "/api/relays", { relays });
      // Invalidate user query to refresh the data
      queryClient.invalidateQueries({ queryKey: ["/api/user"] });
    } finally {
      setIsSavingRelays(false);
    }
  };

  return (
    <div className="space-y-6">
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

      <RelaySettings
        relays={user.relays || []}
        onSave={handleSaveRelays}
        isSaving={isSavingRelays}
      />
    </div>
  );
}