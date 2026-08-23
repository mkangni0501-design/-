'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase, getCurrentAppUser } from '@/lib/supabaseClient';
import { BulletinPost, getPublishedPosts } from '@/lib/bulletin';

type CardKey = 'admin' | 'teacher' | 'parent';

const ADMIN_ROLES = ['system_admin_s', 'admin_a', 'admin_b'];

const CARDS: { key: CardKey; title: string; desc: string; emoji: string }[] = [
  { key: 'admin', title: '管理者', desc: '教務／訓導／總務與系統設定', emoji: '🗂️' },
  { key: 'teacher', title: '教師', desc: '成績登錄、出缺勤、班級查詢', emoji: '🍎' },
  { key: 'parent', title: '家長', desc: '查詢孩子的成績與出缺席紀錄', emoji: '👪' },
];

// 首頁登入卡片上方的「公佈欄」：最新一篇用縮圖凸顯，接下來幾篇只列標題。
// 這裡刻意在還沒登入的頁面就顯示，讓還沒登入的人也能先看到學校最新消息。
function BulletinBoard() {
  const [posts, setPosts] = useState<BulletinPost[] | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    getPublishedPosts(5).then(setPosts);
  }, []);

  if (!posts || posts.length === 0) return null;

  const [latest, ...rest] = posts;
  const expandedPost = posts.find((p) => p.id === expandedId) ?? null;

  return (
    <div style={{ marginBottom: 28 }}>
      <h2 style={{ fontSize: 13, color: '#999', marginBottom: 10 }}>公佈欄</h2>
      <button
        onClick={() => setExpandedId(expandedId === latest.id ? null : latest.id)}
        style={{
          display: 'block',
          width: '100%',
          textAlign: 'left',
          padding: 0,
          border: '1px solid #e5e2da',
          borderRadius: 12,
          background: '#fff',
          cursor: 'pointer',
          overflow: 'hidden',
          marginBottom: 10,
        }}
      >
        {latest.thumbnail_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={latest.thumbnail_url} alt={latest.title} style={{ width: '100%', height: 160, objectFit: 'cover', display: 'block' }} />
        )}
        <div style={{ padding: '10px 14px' }}>
          <span style={{ display: 'block', fontSize: 14, color: '#2C2C2A' }}>{latest.title}</span>
        </div>
      </button>
      {rest.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {rest.map((p) => (
            <li key={p.id}>
              <button
                onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}
                style={{ background: 'none', border: 'none', padding: '4px 0', fontSize: 12, color: '#666', cursor: 'pointer', textAlign: 'left' }}
              >
                ・{p.title}
              </button>
            </li>
          ))}
        </ul>
      )}
      {expandedPost && (
        <div style={{ marginTop: 10, padding: 12, border: '1px solid #eee', borderRadius: 8, fontSize: 13, color: '#444', whiteSpace: 'pre-wrap' }}>
          {expandedPost.content}
        </div>
      )}
    </div>
  );
}

export default function LoginPage() {
  const [card, setCard] = useState<CardKey | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forgotMode, setForgotMode] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const router = useRouter();

  function chooseCard(key: CardKey) {
    setError(null);
    if (key === 'parent') {
      // 家長／學生查詢入口用的是「登入代碼＋信箱驗證信」機制（不是密碼），
      // 沿用既有的 /portal/login 頁面，避免另外做一套不安全的假密碼欄位。
      router.push('/portal/login');
      return;
    }
    setCard(key);
  }

  function backToCards() {
    setCard(null);
    setError(null);
    setForgotMode(false);
    setForgotSent(false);
    setPassword('');
  }

  async function handleForgotPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email) {
      setError('請先輸入電子郵件');
      return;
    }
    const { error: resetErr } = await supabase.auth.resetPasswordForEmail(email);
    if (resetErr) {
      setError('寄送重設密碼信失敗：' + resetErr.message);
      return;
    }
    setForgotSent(true);
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) {
      setError('帳號或密碼錯誤');
      return;
    }

    const appUser = await getCurrentAppUser();
    if (!appUser) {
      setError('找不到對應的使用者角色資料，請聯絡管理員');
      await supabase.auth.signOut();
      return;
    }

    // 用「管理者」卡片登入，但這個帳號其實沒有管理者權限 → 擋下來，請他改用教師卡片
    if (card === 'admin' && !ADMIN_ROLES.includes(appUser.role)) {
      setError('此帳號沒有管理者權限，如果您是教師，請返回改用「教師」卡片登入');
      await supabase.auth.signOut();
      return;
    }

    // 用「教師」卡片登入：即使帳號本身是管理員，畫面也只顯示教師看得到的功能，減少干擾
    if (typeof window !== 'undefined') {
      if (card === 'teacher') {
        sessionStorage.setItem('viewMode', 'teacher');
      } else {
        sessionStorage.removeItem('viewMode');
      }
    }

    // 【修正】原本導師（homeroom_teacher）登入後會被直接導去「一週出缺勤」這個單一
    // 功能頁面，跳過教師權限的功能目錄；其他教師角色才會進 /admin 看到目錄。
    // 這樣導師登入後看不到自己還有哪些功能可以用，要自己想辦法找路回目錄。
    // 統一都先進 /admin——這裡本來就會依角色判斷（isAdminRole && viewMode==='admin'
    // 才顯示六大分類的管理後台，否則顯示攤平的「教學作業」清單），所以不管是導師
    // 還是一般教師，登入後都會直接看到自己權限範圍內的教師功能目錄。
    router.push('/admin');
  }

  // ---------- 第一步：三張角色卡片 ----------
  if (!card) {
    return (
      <main style={{ maxWidth: 460, margin: '80px auto', padding: 24 }}>
        <h1 style={{ fontSize: 20, marginBottom: 4, textAlign: 'center' }}>校務行政系統</h1>
        <p style={{ fontSize: 13, color: '#999', marginBottom: 32, textAlign: 'center' }}>請選擇您的身分登入</p>
        <BulletinBoard />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {CARDS.map((c) => (
            <button
              key={c.key}
              onClick={() => chooseCard(c.key)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                padding: '20px 20px',
                borderRadius: 14,
                border: '1px solid #e5e2da',
                background: '#fff',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <span style={{ fontSize: 28 }}>{c.emoji}</span>
              <span>
                <span style={{ display: 'block', fontSize: 16, color: '#2C2C2A' }}>{c.title}</span>
                <span style={{ display: 'block', fontSize: 12, color: '#999', marginTop: 2 }}>{c.desc}</span>
              </span>
            </button>
          ))}
        </div>
      </main>
    );
  }

  // ---------- 第二步：管理者／教師卡片 → 帳號密碼登入 ----------
  const cardInfo = CARDS.find((c) => c.key === card)!;

  return (
    <main style={{ maxWidth: 360, margin: '80px auto', padding: 24 }}>
      <button
        onClick={backToCards}
        style={{ background: 'none', border: 'none', color: '#999', fontSize: 13, cursor: 'pointer', padding: 0, marginBottom: 16 }}
      >
        ‹ 返回選擇身分
      </button>
      <h1 style={{ fontSize: 20, marginBottom: 24 }}>
        {cardInfo.emoji} {cardInfo.title}登入
      </h1>

      {!forgotMode ? (
        <>
          <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <input
              type="email"
              placeholder="帳號（電子郵件）"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ padding: 10, borderRadius: 8, border: '1px solid #ccc' }}
              required
            />
            <div style={{ position: 'relative' }}>
              <input
                type={showPassword ? 'text' : 'password'}
                placeholder="密碼"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={{ padding: 10, borderRadius: 8, border: '1px solid #ccc', width: '100%', boxSizing: 'border-box', paddingRight: 56 }}
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                style={{
                  position: 'absolute',
                  right: 8,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'none',
                  border: 'none',
                  color: '#666',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                {showPassword ? '隱藏' : '顯示'}
              </button>
            </div>
            {error && <p style={{ color: '#A32D2D', fontSize: 13 }}>{error}</p>}
            <button
              type="submit"
              style={{ padding: 10, borderRadius: 8, background: '#2C2C2A', color: '#fff', border: 'none' }}
            >
              登入
            </button>
          </form>
          <button
            onClick={() => {
              setForgotMode(true);
              setError(null);
              setForgotSent(false);
            }}
            style={{ marginTop: 16, background: 'none', border: 'none', color: '#666', fontSize: 13, textDecoration: 'underline', cursor: 'pointer', padding: 0 }}
          >
            忘記密碼？
          </button>
        </>
      ) : (
        <>
          {forgotSent ? (
            <p style={{ fontSize: 13, color: '#3B6D11', marginBottom: 12 }}>
              已寄出重設密碼信到 {email}，請至信箱點擊連結重設密碼。若您沒有收到信、或無法收信，請聯絡系統管理員協助重設。
            </p>
          ) : (
            <form onSubmit={handleForgotPassword} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <p style={{ fontSize: 13, color: '#666' }}>輸入您的登入信箱，我們會寄送重設密碼連結給您；若無法收信，也可以請系統管理員（S/A/B）協助重製密碼。</p>
              <input
                type="email"
                placeholder="帳號（電子郵件）"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={{ padding: 10, borderRadius: 8, border: '1px solid #ccc' }}
                required
              />
              {error && <p style={{ color: '#A32D2D', fontSize: 13 }}>{error}</p>}
              <button
                type="submit"
                style={{ padding: 10, borderRadius: 8, background: '#2C2C2A', color: '#fff', border: 'none' }}
              >
                寄送重設密碼信
              </button>
            </form>
          )}
          <button
            onClick={() => {
              setForgotMode(false);
              setError(null);
            }}
            style={{ marginTop: 16, background: 'none', border: 'none', color: '#666', fontSize: 13, textDecoration: 'underline', cursor: 'pointer', padding: 0 }}
          >
            返回登入
          </button>
        </>
      )}
    </main>
  );
}
