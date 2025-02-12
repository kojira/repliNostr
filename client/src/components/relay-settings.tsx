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
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Input
            placeholder="wss://relay.example.com"
            value={newRelayUrl}
            onChange={(e) => setNewRelayUrl(e.target.value)}
          />
          <Button onClick={addRelay}>
            <Plus className="h-4 w-4 mr-2" />
            追加
          </Button>
        </div>

        <div className="space-y-2">
          {localRelays.length === 0 ? (
            <div className="text-center text-muted-foreground py-4">
              設定されているリレーがありません
            </div>
          ) : (
            localRelays.map((relay) => (
              <div key={relay.url} className="flex flex-col space-y-2 p-3 border rounded">
                <div className="flex items-center justify-between">
                  <div className="font-medium break-all">{relay.url}</div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => removeRelay(relay.url)}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
                <div className="text-sm text-muted-foreground">
                  ステータス: {relay.read && relay.write ? "読み書き可能" : 
                            relay.read ? "読み取り専用" : 
                            relay.write ? "書き込み専用" : "無効"}
                </div>
                <div className="flex flex-wrap gap-4 pt-2">
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
                </div>
              </div>
            ))
          )}
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
      </CardContent>
    </Card>
  );
}