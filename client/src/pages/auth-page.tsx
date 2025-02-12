import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { Redirect } from "wouter";
import { Loader2, Key, Plug } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function AuthPage() {
  const { user, loginWithExtension, generateNewKeys, isLoading } = useAuth();

  if (user) {
    return <Redirect to="/" />;
  }

  return (
    <div className="min-h-screen grid md:grid-cols-2">
      <div className="flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Connect to Nostr</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-4">
              <Button 
                className="w-full h-12 text-lg"
                onClick={loginWithExtension}
                disabled={isLoading}
              >
                {isLoading ? (
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                ) : (
                  <Plug className="mr-2 h-5 w-5" />
                )}
                Connect with Extension
              </Button>

              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-background px-2 text-muted-foreground">
                    Or
                  </span>
                </div>
              </div>

              <Button 
                variant="outline" 
                className="w-full h-12 text-lg"
                onClick={generateNewKeys}
                disabled={isLoading}
              >
                {isLoading ? (
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                ) : (
                  <Key className="mr-2 h-5 w-5" />
                )}
                Generate New Keys
              </Button>
            </div>

            <Alert>
              <AlertDescription>
                Use a Nostr browser extension like nos2x or Alby for the best experience. 
                If you don't have one installed, you can generate new keys, but make sure to save them securely!
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      </div>
      <div className="hidden md:flex bg-primary items-center justify-center p-8">
        <div className="text-primary-foreground max-w-md space-y-4">
          <h1 className="text-4xl font-bold">Connect to the Nostr Network</h1>
          <p className="text-lg">
            Join the decentralized social network where you own your data and
            connections. Use your existing Nostr extension or generate new keys to get started.
          </p>
        </div>
      </div>
    </div>
  );
}