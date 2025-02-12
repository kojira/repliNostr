import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { useNostr } from "@/hooks/use-nostr";

interface ProfileEditorProps {
  onClose?: () => void;
}

export default function ProfileEditor({ onClose }: ProfileEditorProps) {
  const { updateProfile, isUpdatingProfile } = useNostr();
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [picture, setPicture] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    const profile = {
      ...(name && { name }),
      ...(about && { about }),
      ...(picture && { picture })
    };

    try {
      await updateProfile(profile);
      onClose?.();
    } catch (error) {
      console.error("Failed to update profile:", error);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>プロフィール編集</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">名前</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="あなたの名前"
            />
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="about">自己紹介</Label>
            <Textarea
              id="about"
              value={about}
              onChange={(e) => setAbout(e.target.value)}
              placeholder="あなたについて"
              className="min-h-[100px]"
            />
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="picture">プロフィール画像URL</Label>
            <Input
              id="picture"
              value={picture}
              onChange={(e) => setPicture(e.target.value)}
              placeholder="https://example.com/avatar.jpg"
              type="url"
            />
          </div>

          <div className="flex justify-end space-x-2">
            {onClose && (
              <Button type="button" variant="outline" onClick={onClose}>
                キャンセル
              </Button>
            )}
            <Button type="submit" disabled={isUpdatingProfile}>
              {isUpdatingProfile && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              保存
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
