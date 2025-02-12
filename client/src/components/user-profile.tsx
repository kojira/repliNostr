import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { User } from "@shared/schema";
import { useAuth } from "@/hooks/use-auth";
import { useState } from "react";
import RelaySettings from "./relay-settings";
import { apiRequest, queryClient } from "@/lib/queryClient";
import ProfileEditor from "./profile-editor";
import { Edit } from "lucide-react";

interface UserProfileProps {
  user: User;
}

export default function UserProfile({ user }: UserProfileProps) {
  const { loginMutation } = useAuth();
  const [isSavingRelays, setIsSavingRelays] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

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

  if (isEditing) {
    return (
      <div className="space-y-6">
        <ProfileEditor onClose={() => setIsEditing(false)} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center gap-4">
          <Avatar className="h-16 w-16">
            <AvatarImage src={user.picture} />
            <AvatarFallback>
              {user.username.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold">@{user.username}</h2>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsEditing(true)}
              >
                <Edit className="h-4 w-4" />
              </Button>
            </div>
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