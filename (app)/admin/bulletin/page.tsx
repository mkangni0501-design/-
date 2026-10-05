'use client';

import { useEffect, useState } from 'react';
import { getCurrentAppUser } from '@/lib/supabaseClient';
import { BulletinPost, createPost, deletePost, listAllPosts, updatePost } from '@/lib/bulletin';

const ADMIN_ROLES = ['system_admin_s', 'admin_a', 'admin_b'];

const emptyForm = { title: '', thumbnail_url: '', content: '', is_published: true };

export default function BulletinAdminPage() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [posts, setPosts] = useState<BulletinPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const appUser = await getCurrentAppUser();
      setAllowed(!!appUser && ADMIN_ROLES.includes(appUser.role));
      if (appUser && ADMIN_ROLES.includes(appUser.role)) await reload();
      setLoading(false);
    })();
  }, []);

  async function reload() {
    setPosts(await listAllPosts());
  }

  function startCreate() {
    setEditingId('__new__');
    setForm(emptyForm);
    setError(null);
  }

  function startEdit(p: BulletinPost) {
    setEditingId(p.id);
    setForm({ title: p.title, thumbnail_url: p.thumbnail_url ?? '', content: p.content, is_published: p.is_published });
    setError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(emptyForm);
    setError(null);
  }

  async function handleSave() {
    if (!form.title.trim()) {
      setError('請輸入標題');
      return;
    }
    setSaving(true);
    setError(null);
    let err: string | null;
    if (editingId === '__new__') {
      err = await createPost(form);
    } else {
      const original = posts.find((p) => p.id === editingId);
      err = await updatePost(editingId!, { ...form, published_at: original?.published_at ?? null });
    }
    setSaving(false);
    if (err) {
      setError('儲存失敗：' + err);
      return;
    }
    await reload();
    cancelEdit();
  }

  async function handleDelete(id: string) {
    if (!confirm('確定要刪除這篇公告嗎？刪除後無法復原。')) return;
    const err = await deletePost(id);
    if (err) {
      alert('刪除失敗：' + err);
      return;
    }
    await reload();
  }

  if (loading) {
    return (
      <main style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
        <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>
      </main>
    );
  }

  if (!allowed) {
    return (
      <main style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
        <p style={{ fontSize: 13, color: '#A32D2D' }}>沒有權限使用這個頁面。</p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>公佈欄管理</h1>
      <p style={{ fontSize: 12, color: '#999', marginBottom: 16 }}>
        最新已發布的一篇會在首頁登入卡片上方以縮圖顯示，接下來 4 篇只顯示標題。未發布的文章（草稿）只有管理員自己看得到。
      </p>

      {editingId ? (
        <div style={{ border: '1px solid #eee', borderRadius: 8, padding: 16, marginBottom: 24 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input
              placeholder="標題"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              style={{ padding: 8, border: '1px solid #ccc', borderRadius: 6, fontSize: 13 }}
            />
            <input
              placeholder="縮圖網址（選填，貼圖片的網址即可）"
              value={form.thumbnail_url}
              onChange={(e) => setForm((f) => ({ ...f, thumbnail_url: e.target.value }))}
              style={{ padding: 8, border: '1px solid #ccc', borderRadius: 6, fontSize: 13 }}
            />
            <textarea
              placeholder="內容"
              value={form.content}
              onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
              rows={6}
              style={{ padding: 8, border: '1px solid #ccc', borderRadius: 6, fontSize: 13, fontFamily: 'inherit' }}
            />
            <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={form.is_published} onChange={(e) => setForm((f) => ({ ...f, is_published: e.target.checked }))} />
              發布（取消勾選＝存成草稿，首頁不會顯示）
            </label>
            {error && <p style={{ color: '#A32D2D', fontSize: 12 }}>{error}</p>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={handleSave}
                disabled={saving}
                style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#2C2C2A', color: '#fff', fontSize: 13, cursor: 'pointer' }}
              >
                {saving ? '儲存中…' : '儲存'}
              </button>
              <button onClick={cancelEdit} style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #ccc', background: '#fff', fontSize: 13, cursor: 'pointer' }}>
                取消
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button
          onClick={startCreate}
          style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #2C2C2A', background: '#fff', color: '#2C2C2A', fontSize: 13, cursor: 'pointer', marginBottom: 16 }}
        >
          ＋ 新增公告
        </button>
      )}

      <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {posts.map((p) => (
          <li key={p.id} style={{ border: '1px solid #eee', borderRadius: 8, padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 13 }}>
              {p.title}
              <span style={{ marginLeft: 8, fontSize: 11, color: p.is_published ? '#3B6D11' : '#999' }}>{p.is_published ? '已發布' : '草稿'}</span>
            </span>
            <span style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => startEdit(p)} style={{ fontSize: 12, background: 'none', border: 'none', color: '#2C2C2A', cursor: 'pointer' }}>
                編輯
              </button>
              <button onClick={() => handleDelete(p.id)} style={{ fontSize: 12, background: 'none', border: 'none', color: '#A32D2D', cursor: 'pointer' }}>
                刪除
              </button>
            </span>
          </li>
        ))}
        {posts.length === 0 && <li style={{ fontSize: 12, color: '#bbb' }}>目前沒有任何公告。</li>}
      </ul>
    </main>
  );
}
