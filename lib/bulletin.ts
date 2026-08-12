import { supabase } from './supabaseClient';

export type BulletinPost = {
  id: string;
  title: string;
  thumbnail_url: string | null;
  content: string;
  is_published: boolean;
  published_at: string | null;
  created_at: string;
};

const TABLE = 'bulletin_posts';

/** 首頁（未登入）用：只抓「已發布」的文章，最新的排最前面 */
export async function getPublishedPosts(limit = 5): Promise<BulletinPost[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('id, title, thumbnail_url, content, is_published, published_at, created_at')
    .eq('is_published', true)
    .order('published_at', { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return data as BulletinPost[];
}

/** 公佈欄管理頁用：抓全部（含未發布的草稿） */
export async function listAllPosts(): Promise<BulletinPost[]> {
  const { data, error } = await supabase.from(TABLE).select('*').order('created_at', { ascending: false });
  if (error || !data) return [];
  return data as BulletinPost[];
}

export async function createPost(input: { title: string; thumbnail_url: string; content: string; is_published: boolean }) {
  const { error } = await supabase.from(TABLE).insert({
    title: input.title,
    thumbnail_url: input.thumbnail_url || null,
    content: input.content,
    is_published: input.is_published,
    published_at: input.is_published ? new Date().toISOString() : null,
  });
  return error?.message ?? null;
}

export async function updatePost(
  id: string,
  input: { title: string; thumbnail_url: string; content: string; is_published: boolean; published_at: string | null }
) {
  const { error } = await supabase
    .from(TABLE)
    .update({
      title: input.title,
      thumbnail_url: input.thumbnail_url || null,
      content: input.content,
      is_published: input.is_published,
      // 從未發布→發布時，補上發布時間；已經有發布時間的維持原樣，不會因為編輯內文而改變排序
      published_at: input.is_published ? input.published_at ?? new Date().toISOString() : null,
    })
    .eq('id', id);
  return error?.message ?? null;
}

export async function deletePost(id: string) {
  const { error } = await supabase.from(TABLE).delete().eq('id', id);
  return error?.message ?? null;
}
