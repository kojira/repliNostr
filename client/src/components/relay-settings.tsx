import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Relay, relaySchema } from "@shared/schema";

interface RelaySettingsProps {
  relays?: Relay[];
  onSave?: (relays: Relay[]) => Promise<void>;
  isSaving?: boolean;
}

const DEFAULT_RELAYS: Relay[] = [
  { url: "wss://r.kojira.io", read: true, write: true },
  { url: "wss://x.kojira.io", read: true, write: true }
];

export default function RelaySettings({ 
  relays = DEFAULT_RELAYS,
  onSave,
  isSaving = false 
}: RelaySettingsProps) {
  const [localRelays, setLocalRelays] = useState<Relay[]>(relays);
  const [newRelayUrl, setNewRelayUrl] = useState("");
  const { toast } = useToast();

  const addRelay = () => {
    try {
      const validatedUrl = relaySchema.parse({
        url: newRelayUrl,
        read: true,
        write: true
      });

      if (localRelays.some(relay => relay.url === newRelayUrl)) {
        toast({
          title: "エラー",
          description: "このリレーは既に追加されています",
          variant: "destructive",
        });
        return;
      }

      setLocalRelays([...localRelays, validatedUrl]);
      setNewRelayUrl("");
    } catch (error) {
      toast({
        title: "エラー",
        description: "無効なリレーURLです",
        variant: "destructive",
      });
    }
  };

  const removeRelay = (url: string) => {
    setLocalRelays(localRelays.filter(relay => relay.url !== url));
  };

  const toggleRead = (url: string) => {
    setLocalRelays(localRelays.map(relay => 
      relay.url === url ? { ...relay, read: !relay.read } : relay
    ));
  };

  const toggleWrite = (url: string) => {
    setLocalRelays(localRelays.map(relay => 
      relay.url === url ? { ...relay, write: !relay.write } : relay
    ));
  };

  const handleSave = async () => {
    if (!onSave) return;

    try {
      await onSave(localRelays);
      toast({
        title: "成功",
        description: "リレー設定を保存しました",
      });
    } catch (error) {
      toast({
        title: "エラー",
        description: "リレー設定の保存に失敗しました",
        variant: "destructive",
      });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>リレー設定</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="flex gap-2">
            <Input
              placeholder="wss://relay.example.com"
              value={newRelayUrl}
              onChange={(e) => setNewRelayUrl(e.target.value)}
            />
            <Button onClick={addRelay}>
              <Plus className="h-4 w-4 mr-2" />
              リレーを追加
            </Button>
          </div>

          <div className="space-y-2">
            {localRelays.map((relay) => (
              <div key={relay.url} className="flex items-center gap-4 p-2 border rounded">
                <div className="flex-1 truncate">{relay.url}</div>
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={relay.read}
                      onCheckedChange={() => toggleRead(relay.url)}
                    />
                    <Label>読み取り</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={relay.write}
                      onCheckedChange={() => toggleWrite(relay.url)}
                    />
                    <Label>書き込み</Label>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => removeRelay(relay.url)}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
          </div>

          {onSave && (
            <Button 
              onClick={handleSave} 
              disabled={isSaving}
              className="w-full"
            >
              {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              変更を保存
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}