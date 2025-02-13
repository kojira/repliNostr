import { Switch, Route, Router } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { AuthProvider } from "./hooks/use-auth";
import NotFound from "@/pages/not-found";
import AuthPage from "@/pages/auth-page";
import HomePage from "@/pages/home-page";
import ProfilePage from "@/pages/profile-page";
import { ProtectedRoute } from "./lib/protected-route";

// GitHub Pages用のベースパスを取得（末尾のスラッシュを含めない）
const base = import.meta.env.DEV ? '' : '/repliNostr';

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Router base={base}>
          <Switch>
            <Route path="/auth" component={AuthPage} />
            <ProtectedRoute path="/" component={HomePage} />
            <ProtectedRoute path="/profile/:pubkey" component={ProfilePage} />
            <Route component={NotFound} />
          </Switch>
        </Router>
        <Toaster />
      </AuthProvider>
    </QueryClientProvider>
  );
}
