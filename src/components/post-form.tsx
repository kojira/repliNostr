import { useForm } from "react-hook-form";
import { Button } from "./ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "./ui/form";
import { Textarea } from "./ui/textarea";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useNostr } from "@/hooks/use-nostr";
import { useCallback } from "react";

const postFormSchema = z.object({
  content: z.string().min(1, "投稿内容を入力してください"),
});

type PostFormData = z.infer<typeof postFormSchema>;

export function PostForm() {
  const { publishPost } = useNostr();
  const form = useForm<PostFormData>({
    resolver: zodResolver(postFormSchema),
    defaultValues: {
      content: "",
    },
  });

  const onSubmit = useCallback(async (data: PostFormData) => {
    await publishPost(data.content);
    form.reset();
  }, [publishPost, form]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      form.handleSubmit(onSubmit)();
    }
  }, [form, onSubmit]);

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="content"
          render={({ field }) => (
            <FormItem>
              <FormLabel>投稿内容</FormLabel>
              <FormControl>
                <Textarea
                  placeholder="何を共有したいですか？"
                  {...field}
                  onKeyDown={handleKeyDown}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit">投稿</Button>
      </form>
    </Form>
  );
}
