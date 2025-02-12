import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useState } from "react";
import ProfileEditor from "./profile-editor";
import { Edit } from "lucide-react";
import { useNostr } from "@/hooks/use-nostr";
import RelaySettings from "./relay-settings";
import { apiRequest, queryClient } from "@/lib/queryClient";

export default function UserProfile() {
  const { user } = useAuth();
  const { getUserMetadata } = useNostr();
  const [isEditing, setIsEditing] = useState(false);
  const [isSavingRelays, setIsSavingRelays] = useState(false);

  if (!user) return null;

  const metadata = getUserMetadata(user.publicKey);
  const shortPubkey = user.publicKey.slice(0, 8);

  const handleSaveRelays = async (relays: any) => { //Type needs fixing here.  Should be based on User.relays
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
          <div className="flex-1">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold">
                {metadata?.name || `nostr:${shortPubkey}`}
              </h2>
            </div>
            <p className="text-sm text-muted-foreground truncate">
              {user.publicKey}
            </p>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {metadata?.about && (
            <p className="text-sm text-muted-foreground">{metadata.about}</p>
          )}
          <Button
            variant="outline"
            className="w-full"
            onClick={() => setIsEditing(true)}
          >
            <Edit className="mr-2 h-4 w-4" />
            プロフィールを編集
          </Button>
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