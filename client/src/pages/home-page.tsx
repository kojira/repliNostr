import { useAuth } from "@/hooks/use-auth";
import { useNostr } from "@/hooks/use-nostr";
import PostCard from "@/components/post-card";
import PostForm from "@/components/post-form";
import UserProfile from "@/components/user-profile";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

export default function HomePage() {
  const { user, logoutMutation } = useAuth();
  const { posts, isLoadingPosts, createPost, isCreatingPost } = useNostr();

  if (!user) return null;

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-8">
        <div className="grid gap-8 md:grid-cols-[300px_1fr]">
          <aside className="space-y-6">
            <UserProfile user={user} />
            <Button 
              variant="outline" 
              onClick={() => logoutMutation.mutate()}
              className="w-full"
            >
              Logout
            </Button>
          </aside>

          <main className="space-y-6">
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
    </div>
  );
}