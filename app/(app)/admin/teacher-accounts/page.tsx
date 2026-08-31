'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import ErrorBanner from '@/components/ErrorBanner';

type TeacherRow = {
  id: string;
  name: string;
  app_user_id: string | null;
  accountLabel: string;
  homeroomCount: number;
  scheduleCount: number;
};

// 這頁是用來解決「同一位老師被系統記成兩筆不同 teachers 資料」的問題：
// 通常發生在「任課教師設定」或「班級與導師設定」用打字輸入姓名建立教師資料，
// 後來邀請帳號時名字沒有完全對上（多一個空格、簡稱、全形半形不同...），
// 就會多出一筆沒有連結登入帳號的重複資料，導致這位老師登入後很多頁面看起來「什麼都沒有」。
export default function TeacherAccountsPage() {
  const [rows, setRows] = useState<TeacherRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [keepId, setKeepId] = useState<string | null>(null);
  const [mergeIds, setMergeIds] = useState<Set<string>>(new Set());
  const [merging, setMerging] = useState(false);

  async function load() {
    setLoading(true);
    const { data: teacherRows, error } = await supabase.from('teachers').select('id, name, app_user_id').order('name');
    if (error) {
      setLoadError('讀取教師清單失敗：' + error.message);
      setLoading(false);
      return;
    }

    const appUserIds = (teacherRows ?? []).map((t: any) => t.app_user_id).filter(Boolean);
    const { data: appUserRows } = await supabase
      .from('app_users')
      .select('id, name')
      .in('id', appUserIds.length > 0 ? appUserIds : ['00000000-0000-0000-0000-000000000000']);
    const appUserNameById = new Map((appUserRows ?? []).map((u: any) => [u.id, u.name]));

    const { data: classRows } = await supabase.from('classes').select('homeroom_teacher_id').not('homeroom_teacher_id', 'is', null);
    const homeroomCountById = new Map<string, number>();
    (classRows ?? []).forEach((c: any) => {
      homeroomCountById.set(c.homeroom_teacher_id, (homeroomCountById.get(c.homeroom_teacher_id) ?? 0) + 1);
    });

    // 只算「學校課表」已經排進實際星期/節次的資料列；「任課教師設定」單純指派「誰教哪班哪科」時
    // weekday/period_no 會是 null（還沒排進實際時段），這種不能算進「排課堂數」，
    // 不然還沒排課表的老師也會被誤判成「已經有排課」，看起來像是登入沒問題，掩蓋掉真正沒被排進課表的狀況。
    const { data: scheduleRows } = await supabase
      .from('class_schedule')
      .select('teacher_id')
      .not('weekday', 'is', null)
      .not('period_no', 'is', null);
    const scheduleCountById = new Map<string, number>();
    (scheduleRows ?? []).forEach((s: any) => {
      scheduleCountById.set(s.teacher_id, (scheduleCountById.get(s.teacher_id) ?? 0) + 1);
    });

    setRows(
      (teacherRows ?? []).map((t: any) => ({
        id: t.id,
        name: t.name,
        app_user_id: t.app_user_id,
        accountLabel: t.app_user_id ? appUserNameById.get(t.app_user_id) ?? '（帳號名稱查無資料）' : '未連結登入帳號',
        homeroomCount: homeroomCountById.get(t.id) ?? 0,
        scheduleCount: scheduleCountById.get(t.id) ?? 0,
      }))
    );
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  const nameCounts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.name] = (acc[r.name] ?? 0) + 1;
    return acc;
  }, {});
  const duplicateNames = Object.entries(nameCounts).filter(([, n]) => n > 1).length;

  function toggleMerge(id: string) {
    setMergeIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleMerge() {
    if (!keepId || mergeIds.size === 0) return;
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) {
      alert('請重新登入');
      return;
    }
    setMerging(true);
    try {
      const res = await fetch('/api/admin/merge-teachers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ keepId, mergeIds: Array.from(mergeIds) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert('合併失敗：' + (body.error ?? '未知錯誤'));
        return;
      }
      if (body.errors?.length > 0) {
        alert('合併完成，但有部分問題：\n' + body.errors.join('\n'));
      } else {
        alert(`已把資料合併到「${body.keptName}」`);
      }
      setKeepId(null);
      setMergeIds(new Set());
      load();
    } finally {
      setMerging(false);
    }
  }

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>教師資料檢查／合併</h1>
      <ErrorBanner message={loadError} />
      <p style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
        如果某位老師登入後在「成績登錄」「出缺席登錄」等頁面選得到班級/科目，但學生名單一直是空的，
        很可能是同一個人被系統記成了兩筆不同的教師資料——通常一筆是「任課教師設定」或「班級與導師設定」用打字建立、
        沒有連結登入帳號的，另一筆才是真正連結到登入帳號的。用下面的清單找出同名的重複資料，選好「保留哪一筆」後按合併，
        班級/課表/成績等資料都會自動改指到保留的那一筆。
      </p>
      {duplicateNames > 0 && (
        <p style={{ fontSize: 12, color: '#A36A2D', marginBottom: 16 }}>
          偵測到 {duplicateNames} 個姓名有超過一筆教師資料，以下已用底色標示。
        </p>
      )}

      {loading ? (
        <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>
      ) : (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 16 }}>
            <thead>
              <tr>
                <th style={{ padding: 6 }}>保留</th>
                <th style={{ padding: 6 }}>合併掉</th>
                <th style={{ textAlign: 'left', padding: 6 }}>姓名</th>
                <th style={{ textAlign: 'left', padding: 6 }}>連結帳號</th>
                <th style={{ textAlign: 'right', padding: 6 }}>擔任導師班數</th>
                <th style={{ textAlign: 'right', padding: 6 }}>排課堂數（學校課表）</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ borderTop: '1px solid #eee', background: nameCounts[r.name] > 1 ? '#FFF7EC' : undefined }}>
                  <td style={{ padding: 6, textAlign: 'center' }}>
                    <input type="radio" name="keep" checked={keepId === r.id} onChange={() => setKeepId(r.id)} />
                  </td>
                  <td style={{ padding: 6, textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      checked={mergeIds.has(r.id)}
                      disabled={keepId === r.id}
                      onChange={() => toggleMerge(r.id)}
                    />
                  </td>
                  <td style={{ padding: 6 }}>{r.name}</td>
                  <td style={{ padding: 6 }}>{r.accountLabel}</td>
                  <td style={{ padding: 6, textAlign: 'right' }}>{r.homeroomCount}</td>
                  <td style={{ padding: 6, textAlign: 'right' }}>{r.scheduleCount}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ padding: 12, textAlign: 'center', color: '#999' }}>
                    目前沒有任何教師資料
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <button
            onClick={handleMerge}
            disabled={!keepId || mergeIds.size === 0 || merging}
            style={{ padding: '8px 16px', background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13 }}
          >
            {merging ? '合併中…' : `合併選取的 ${mergeIds.size} 筆到保留的那一筆`}
          </button>
        </>
      )}
    </main>
  );
}
