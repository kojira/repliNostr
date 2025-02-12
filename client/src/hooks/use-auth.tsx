import { createContext, ReactNode, useContext, useEffect, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import * as secp from '@noble/secp256k1';
import { getPublicKey } from 'nostr-tools';

// Define types for Nostr window object
declare global {
  interface Window {
    nostr?: {
      getPublicKey(): Promise<string>;
      signEvent(event: any): Promise<any>;
    };
  }
}

type NostrUser = {
  type: "extension" | "generated";
  publicKey: string;
  privateKey?: string; // Only present for generated keys
};

type AuthContextType = {
  user: NostrUser | null;
  isLoading: boolean;
  error: Error | null;
  loginWithExtension: () => Promise<void>;
  generateNewKeys: () => Promise<void>;
  logout: () => void;
};

export const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  const [user, setUser] = useState<NostrUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Initialize from localStorage
  useEffect(() => {
    const storedAuth = localStorage.getItem("nostr_auth");
    if (storedAuth) {
      try {
        const parsed = JSON.parse(storedAuth);
        setUser(parsed);
      } catch (e) {
        console.error("Failed to parse stored auth:", e);
      }
    }
    setIsLoading(false);
  }, []);

  const loginWithExtension = async () => {
    try {
      setIsLoading(true);
      if (!window.nostr) {
        throw new Error("No Nostr extension found. Please install a Nostr extension.");
      }

      const publicKey = await window.nostr.getPublicKey();
      const user: NostrUser = {
        type: "extension",
        publicKey
      };

      setUser(user);
      localStorage.setItem("nostr_auth", JSON.stringify(user));

      toast({
        title: "Login Successful",
        description: "Connected with Nostr extension",
      });
    } catch (e) {
      const error = e as Error;
      setError(error);
      toast({
        title: "Login Failed",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const generateNewKeys = async () => {
    try {
      setIsLoading(true);
      // Generate a random 32-byte private key
      const privateKeyBytes = new Uint8Array(32);
      window.crypto.getRandomValues(privateKeyBytes);
      const privateKey = Buffer.from(privateKeyBytes).toString('hex');
      const publicKey = getPublicKey(privateKey);

      const user: NostrUser = {
        type: "generated",
        publicKey,
        privateKey
      };

      setUser(user);
      localStorage.setItem("nostr_auth", JSON.stringify(user));

      toast({
        title: "Keys Generated",
        description: "新しいNostrキーが生成されました。秘密鍵を安全に保管してください！",
      });
    } catch (e) {
      const error = e as Error;
      setError(error);
      toast({
        title: "Key Generation Failed",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const logout = () => {
    setUser(null);
    localStorage.removeItem("nostr_auth");
    toast({
      title: "Logged Out",
      description: "Successfully logged out",
    });
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        error,
        loginWithExtension,
        generateNewKeys,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}