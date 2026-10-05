'use client';

import { useEffect, useState } from 'react';
import { supabase, getCurrentAppUser, getCurrentTeacherId } from '@/lib/supabaseClient';

// 【本輪修正】反映事項「查看獎懲頁...目前管理者用教師視角可以看到其他人的敘獎
// 資料，請修正為訓導/系統管理員S、A 視角全校都看得到；導師看得到本班學生＋
// 自己登記過的授課學生；一般教師只看得到自己登記過的；家長/學生只看得到自己。
// 且增加姓名/學號查詢該生目前獎懲紀錄功能」——
//
// 根因：conduct_events 的 read_conduct_events_for_history 政策（sql/98）是
// 依「登入帳號實際的角色／部門」判斷可見範圍，管理員帳號不管畫面上有沒有切換
// 成「教師視角」（sessionStorage.viewMode），在資料庫眼裡都還是原本的角色，
// RLS 一樣會把全校資料都放行——「切換視角」本來就只是前端模擬給管理員自己
// 預覽教師會看到什麼畫面用的，不會真的改變資料庫判斷的身分，所以用管理員
// 帳號切到教師視角，RLS 這一關還是會把全校資料都撈回來，等於「切換視角」這個
// 功能在這頁完全沒有生效。
// 修法：這裡額外判斷 sessionStorage.viewMode==='teacher'，是的話不管實際角色
// 是什麼，都在前端把結果限縮成「自己登記過的」＋「自己導師班學生的」這個教師
// 視角應該看到的範圍，不依賴 RLS 幫忙限縮（RLS 對管理員帳號本來就不會限縮）。
// 真正用教師帳號登入（不是用管理員帳號切視角）的話，RLS 本來就已經正確限縮，
// 這裡的前端過濾只是再做一次、不會有任何差異、不影響其他身分的正常使用。
type EventRow = {
  id: string;
  student_no: string;
  event_date: string;
  event_type: string;
  count: number;
  points: number;
  reason: string | null;
  created_at: string;
  recorded_by: string | null;
};

const CATEGORY_ORDER = ['大功', '小功', '嘉獎', '警告', '小過', '大過'];

export default function RewardsHistoryPage() {
  const [rows, setRows] = useState<EventRow[]>([]);
  const [nameByNo, setNameByNo] = useState<Record<string, string>>({});
  const [keyword, setKeyword] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('全部');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [simulatingTeacher, setSimulatingTeacher] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const appUser = await getCurrentAppUser();
      if (!appUser) {
        setLoading(false);
        return;
      }
      const { data, error } = await supabase
        .from('conduct_events')
        .select('id, student_no, event_date, event_type, count, points, reason, created_at, recorded_by')
        .order('event_date', { ascending: false })
        .order('created_at', { ascending: false });
      if (error) {
        setLoadError('讀取獎懲紀錄失敗：' + error.message);
        setLoading(false);
        return;
      }
      let list = (data ?? []) as EventRow[];

      const viewingAsTeacher = typeof window !== 'undefined' && sessionStorage.getItem('viewMode') === 'teacher';
      setSimulatingTeacher(viewingAsTeacher);
      if (viewingAsTeacher) {
        const myTeacherId = await getCurrentTeacherId();
        let ownHomeroomStudentNos = new Set<string>();
        if (myTeacherId) {
          const { data: homeroomClasses } = await supabase.from('classes').select('id').eq('homeroom_teacher_id', myTeacherId);
          const classIds = (homeroomClasses ?? []).map((c: any) => c.id);
          if (classIds.length > 0) {
            const { data: enroll } = await supabase
              .from('enrollments')
              .select('student_no')
              .in('class_id', classIds)
              .eq('is_current', true);
            ownHomeroomStudentNos = new Set((enroll ?? []).map((e: any) => e.student_no));
          }
        }
        list = list.filter((r) => r.recorded_by === myTeacherId || ownHomeroomStudentNos.has(r.student_no));
      }

      setRows(list);
      const nos = Array.from(new Set(list.map((r) => r.student_no)));
      if (nos.length > 0) {
        const { data: studs } = await supabase.from('students').select('student_no, name').in('student_no', nos);
        const map: Record<string, string> = {};
        (studs ?? []).forEach((s: any) => (map[s.student_no] = s.name));
        setNameByNo(map);
      }
      setLoading(false);
    })();
  }, []);

  const filtered = rows.filter((r) => {
    if (typeFilter !== '全部' && r.event_type !== typeFilter) return false;
    if (keyword) {
      const name = nameByNo[r.student_no] ?? '';
      if (!name.includes(keyword) && !r.student_no.includes(keyword)) return false;
    }
    return true;
  });

  return (
    <main style={{ maxWidth: 900, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>查看獎懲</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        只顯示已經正式生效（審核通過或訓導/管理員直接登記）的獎懲紀錄。訓導部門／系統管理員S／管理員A 看得到全校；導師看得到本班學生＋自己登記過的學生；一般教師只看得到自己登記過的學生。
        {simulatingTeacher && '（目前是「教師視角」預覽，畫面已依教師身分限縮範圍）'}
      </p>
      {loadError && <p style={{ fontSize: 13, color: '#A32D2D', marginBottom: 12 }}>{loadError}</p>}

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          placeholder="輸入姓名或學號查詢該生目前的獎懲紀錄"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          style={{ padding: 8, flex: 1, minWidth: 220 }}
        />
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={{ padding: 8 }}>
          <option value="全部">全部類別</option>
          {CATEGORY_ORDER.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: 6 }}>登記時間</th>
              <th style={{ textAlign: 'left', padding: 6 }}>學生</th>
              <th style={{ textAlign: 'left', padding: 6 }}>類別</th>
              <th style={{ textAlign: 'right', padding: 6 }}>次數</th>
              <th style={{ textAlign: 'left', padding: 6 }}>事由</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} style={{ borderTop: '1px solid #eee' }}>
                <td style={{ padding: 6, whiteSpace: 'nowrap' }}>{new Date(r.created_at).toLocaleString('zh-TW')}</td>
                <td style={{ padding: 6 }}>
                  {nameByNo[r.student_no] ?? r.student_no}（{r.student_no}）
                </td>
                <td style={{ padding: 6 }}>{r.event_type}</td>
                <td style={{ padding: 6, textAlign: 'right' }}>{r.count}</td>
                <td style={{ padding: 6, color: '#666' }}>{r.reason ?? ''}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} style={{ padding: 12, textAlign: 'center', color: '#999' }}>
                  沒有符合條件的紀錄
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </main>
  );
}
