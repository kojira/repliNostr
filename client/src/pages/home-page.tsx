import { useAuth } from "@/hooks/use-auth";
import { useNostr } from "@/hooks/use-nostr";
import PostCard from "@/components/post-card";
import PostForm from "@/components/post-form";
import Navbar from "@/components/navbar";
import { Loader2 } from "lucide-react";

export default function HomePage() {
  const { user } = useAuth();
  const { posts, isLoadingPosts, createPost, isCreatingPost } = useNostr();

  if (!user) return null;

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <div className="container mx-auto px-4 py-8">
        <main className="max-w-2xl mx-auto space-y-6">
          <PostForm onSubmit={createPost} isSubmitting={isCreatingPost} />

          {isLoadingPosts ? (
            <div className="flex justify-center p-8">
              <Loader2 className="h-8 w-8 animate-spin" />
            </div>
          ) : (
            <div className="space-y-4">
              {posts.map((post) => (
                <PostCard 
                  key={`${post.nostrEventId}-${post.userId}`}
                  post={post}
                />
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}