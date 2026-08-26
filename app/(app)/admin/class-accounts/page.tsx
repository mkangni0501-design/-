'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { namesLikelySamePerson } from '@/lib/periodConfig';
import ErrorBanner from '@/components/ErrorBanner';

type ClassRow = {
  id: string;
  academic_year: number;
  grade_level: string;
  class_name: string;
  homeroomName: string;
  studentCount: number;
  scheduleCount: number;
};

// 這頁解決「同一個班被系統記成兩筆不同 classes 資料」的問題（例如排課系統匯入一次、
// 一鍵上傳或手動新增又建了一次，class_name 打法稍有不同，例如「高三」vs「忠班」其實是同一班）：
// 一鍵下載/查詢會看到同一個班出現兩次，學生名單、課表、成績也會分散在兩筆不同資料上。
// 用下面的清單找出同學年度＋同年級裡看起來像重複的班級，選好「保留哪一筆」後按合併，
// 學生名單/課表/代課安排都會自動改指到保留的那一筆。
export default function ClassAccountsPage() {
  const [rows, setRows] = useState<ClassRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [keepId, setKeepId] = useState<string | null>(null);
  const [mergeIds, setMergeIds] = useState<Set<string>>(new Set());
  const [merging, setMerging] = useState(false);

  async function load() {
    setLoading(true);
    const { data: classRows, error } = await supabase
      .from('classes')
      .select('id, academic_year, grade_level, class_name, homeroom_teacher_id, teachers(name)')
      .order('academic_year', { ascending: false })
      .order('grade_level')
      .order('class_name');
    if (error) {
      setLoadError('讀取班級清單失敗：' + error.message);
      setLoading(false);
      return;
    }
    const { data: enrollRows } = await supabase.from('enrollments').select('class_id').eq('is_current', true);
    const studentCountById = new Map<string, number>();
    (enrollRows ?? []).forEach((e: any) => studentCountById.set(e.class_id, (studentCountById.get(e.class_id) ?? 0) + 1));

    const { data: scheduleRows } = await supabase.from('class_schedule').select('class_id').not('weekday', 'is', null).not('period_no', 'is', null);
    const scheduleCountById = new Map<string, number>();
    (scheduleRows ?? []).forEach((s: any) => scheduleCountById.set(s.class_id, (scheduleCountById.get(s.class_id) ?? 0) + 1));

    setRows(
      (classRows ?? []).map((c: any) => ({
        id: c.id,
        academic_year: c.academic_year,
        grade_level: c.grade_level,
        class_name: c.class_name,
        homeroomName: c.teachers?.name ?? '（未設定導師）',
        studentCount: studentCountById.get(c.id) ?? 0,
        scheduleCount: scheduleCountById.get(c.id) ?? 0,
      }))
    );
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  // 同學年度＋同年級底下，只要有兩筆（含）以上就標成「這組要留意」，班級名稱正規化後很像
  // （多空格/簡稱/全形半形）的另外用底色標出來，提醒可能就是同一班打法不同。
  const groupKey = (r: ClassRow) => `${r.academic_year}-${r.grade_level}`;
  const countByGroup = rows.reduce<Record<string, number>>((acc, r) => {
    const k = groupKey(r);
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  const likelyDuplicateIds = new Set<string>();
  rows.forEach((a) => {
    rows.forEach((b) => {
      if (a.id !== b.id && groupKey(a) === groupKey(b) && namesLikelySamePerson(a.class_name, b.class_name)) {
        likelyDuplicateIds.add(a.id);
        likelyDuplicateIds.add(b.id);
      }
    });
  });

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
      const res = await fetch('/api/admin/merge-classes', {
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
        const notes: string[] = [];
        if (body.renumbered && Object.keys(body.renumbered).length > 0) {
          notes.push('部分學生座號有衝突，已自動改配到下一個空號，建議合併後檢查一下座號：' + JSON.stringify(body.renumbered));
        }
        if (body.skippedDuplicates && Object.keys(body.skippedDuplicates).length > 0) {
          notes.push('已略過的重複課表/代課資料：' + JSON.stringify(body.skippedDuplicates));
        }
        alert(`已把資料合併到「${body.keptLabel}」` + (notes.length ? '\n\n' + notes.join('\n') : ''));
      }
      setKeepId(null);
      setMergeIds(new Set());
      load();
    } finally {
      setMerging(false);
    }
  }

  return (
    <main style={{ maxWidth: 800, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>班級資料檢查／合併</h1>
      <ErrorBanner message={loadError} />
      <p style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
        如果「一鍵下載」或各分頁的班級清單裡，同一個班出現兩次（例如「高三」跟「忠班」其實是同一班，只是不同時候用不同打法建立），
        用下面清單找出同學年度＋同年級裡看起來重複的班級，選好「保留哪一筆」後按合併，學生名單/課表/代課安排都會自動改指到保留的那一筆，
        多餘的那筆會被刪除。
      </p>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        往後上傳/匯入時，如果班級名稱打法稍有不同（多空格、簡稱、全形半形），系統會先試著比對成同一班，不會再無聲無息地建出新的重複班級；
        但打法差異太大（像「高三」跟「忠班」這種完全不同的名字）系統無法自動判斷，還是要靠這頁手動處理。
      </p>
      {likelyDuplicateIds.size > 0 && (
        <p style={{ fontSize: 12, color: '#A36A2D', marginBottom: 16 }}>
          偵測到 {likelyDuplicateIds.size} 筆班級名稱很像（已用底色標示），但「打法差異太大」的重複（例如高三／忠班）不會被自動抓出來，麻煩自己對照確認。
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
                <th style={{ textAlign: 'left', padding: 6 }}>學年度</th>
                <th style={{ textAlign: 'left', padding: 6 }}>年級</th>
                <th style={{ textAlign: 'left', padding: 6 }}>班級名稱</th>
                <th style={{ textAlign: 'left', padding: 6 }}>導師</th>
                <th style={{ textAlign: 'right', padding: 6 }}>在學學生數</th>
                <th style={{ textAlign: 'right', padding: 6 }}>排課堂數</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  style={{
                    borderTop: '1px solid #eee',
                    background: likelyDuplicateIds.has(r.id) ? '#FFF7EC' : countByGroup[groupKey(r)] > 1 ? '#FAFAF8' : undefined,
                  }}
                >
                  <td style={{ padding: 6, textAlign: 'center' }}>
                    <input type="radio" name="keep" checked={keepId === r.id} onChange={() => setKeepId(r.id)} />
                  </td>
                  <td style={{ padding: 6, textAlign: 'center' }}>
                    <input type="checkbox" checked={mergeIds.has(r.id)} disabled={keepId === r.id} onChange={() => toggleMerge(r.id)} />
                  </td>
                  <td style={{ padding: 6 }}>{r.academic_year}</td>
                  <td style={{ padding: 6 }}>{r.grade_level}</td>
                  <td style={{ padding: 6 }}>{r.class_name}</td>
                  <td style={{ padding: 6 }}>{r.homeroomName}</td>
                  <td style={{ padding: 6, textAlign: 'right' }}>{r.studentCount}</td>
                  <td style={{ padding: 6, textAlign: 'right' }}>{r.scheduleCount}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ padding: 12, textAlign: 'center', color: '#999' }}>
                    目前沒有任何班級資料
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
