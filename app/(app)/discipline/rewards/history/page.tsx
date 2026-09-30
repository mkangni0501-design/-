'use client';

import { useEffect, useState } from 'react';
import { supabase, getCurrentAppUser } from '@/lib/supabaseClient';

// 【本輪新增】反映事項「增加查看獎懲頁面（導師只能看自己班學生以及被自己輸入過
// 獎懲的學生；一般教師只能看自己輸入過獎懲的學生；家長及同學只能看到自己的），
// 內容為登記時間、事由、獎懲類別、次數」——這頁本身不用在前端另外組角色判斷的
// 查詢條件：conduct_events 的 read_conduct_events_for_history 政策（sql/98）已經
// 把「訓導/系統管理員S 全校、導師本班學生、任何人自己登記過的、家長/學生看自己」
// 這幾種情況都定義好了，這裡直接對 conduct_events 下一個不限條件的查詢，
// 資料庫回傳的自然就是「這個登入身分看得到的那些」。
// 家長／學生（portal 帳號）走的是完全不同的登入方式，這頁是給校務系統（app_users）
// 登入的教師/管理員看的；家長/學生視角的獎懲改在「家長/學生查詢入口」頁本身
// 加一個分頁，見 app/(app)/portal/page.tsx。
type EventRow = {
  id: string;
  student_no: string;
  event_date: string;
  event_type: string;
  count: number;
  points: number;
  reason: string | null;
  created_at: string;
};

const CATEGORY_ORDER = ['大功', '小功', '嘉獎', '警告', '小過', '大過'];

export default function RewardsHistoryPage() {
  const [rows, setRows] = useState<EventRow[]>([]);
  const [nameByNo, setNameByNo] = useState<Record<string, string>>({});
  const [keyword, setKeyword] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('全部');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

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
        .select('id, student_no, event_date, event_type, count, points, reason, created_at')
        .order('event_date', { ascending: false })
        .order('created_at', { ascending: false });
      if (error) {
        setLoadError('讀取獎懲紀錄失敗：' + error.message);
        setLoading(false);
        return;
      }
      const list = (data ?? []) as EventRow[];
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
        只顯示已經正式生效（審核通過或訓導/管理員直接登記）的獎懲紀錄。導師會看到本班學生的紀錄，加上您自己登記過的其他學生；一般教師只會看到自己登記過的學生。
      </p>
      {loadError && <p style={{ fontSize: 13, color: '#A32D2D', marginBottom: 12 }}>{loadError}</p>}

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          placeholder="搜尋姓名或學號"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          style={{ padding: 8, flex: 1, minWidth: 160 }}
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
