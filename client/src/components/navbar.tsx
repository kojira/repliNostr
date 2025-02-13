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
import { useAuth } from "@/hooks/use-auth";

export default function Navbar() {
  const { user, logout } = useAuth();

  if (!user) return null;

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container mx-auto px-4 h-14 flex items-center justify-between">
        <h1 className="text-lg font-semibold sm:text-xl">Nostr Client</h1>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="shrink-0">
              <MenuIcon className="h-5 w-5" />
              <span className="sr-only">メニューを開く</span>
            </Button>
          </SheetTrigger>
          <SheetContent side="right" className="w-[280px] sm:w-[320px] px-4">
            <SheetHeader className="mb-4">
              <SheetTitle className="text-left">メニュー</SheetTitle>
            </SheetHeader>
            <div className="space-y-6">
              <UserProfile />
              <Button 
                variant="outline" 
                onClick={() => logout()}
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