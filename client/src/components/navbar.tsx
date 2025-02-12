import { MenuIcon } from "lucide-react";
import { Button } from "./ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./ui/sheet";
import UserProfile from "./user-profile";
import RelaySettings from "./relay-settings";
import { useAuth } from "@/hooks/use-auth";

export default function Navbar() {
  const { user, logoutMutation } = useAuth();

  if (!user) return null;

  return (
    <header className="border-b">
      <div className="container mx-auto px-4 h-16 flex items-center justify-between">
        <h1 className="text-xl font-bold">Nostr Client</h1>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon">
              <MenuIcon className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>メニュー</SheetTitle>
            </SheetHeader>
            <div className="mt-4 space-y-6">
              <UserProfile user={user} />
              <div>
                <SheetTitle className="mb-4">リレー設定</SheetTitle>
                <RelaySettings />
              </div>
              <Button 
                variant="outline" 
                onClick={() => logoutMutation.mutate()}
                className="w-full"
              >
                ログアウト
              </Button>
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </header>
  );
}