'use client';

import { useEffect, useState } from 'react';
import { supabase, getCurrentAppUser, isAdminInCurrentView } from '@/lib/supabaseClient';

type RankRow = {
  enrollment_id: string;
  seat_no: number;
  name: string;
  total_score: number;
  class_rank: number;
};
type ClassOption = { id: string; label: string };

export default function ClassResultsPage() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [classOptions, setClassOptions] = useState<ClassOption[]>([]);
  const [classId, setClassId] = useState('');
  const [className, setClassName] = useState('');
  const [rows, setRows] = useState<RankRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const appUser = await getCurrentAppUser();
      if (!appUser) return;
      const admin = isAdminInCurrentView(appUser.role);
      setIsAdmin(admin);

      if (admin) {
        // 管理員：可以選任何一個班級查看
        const { data: allClasses } = await supabase
          .from('classes')
          .select('id, academic_year, grade_level, class_name')
          .order('academic_year', { ascending: false })
          .order('grade_level');
        const options = (allClasses ?? []).map((c: any) => ({
          id: c.id,
          label: `${c.academic_year} ${c.grade_level}${c.class_name}`,
        }));
        setClassOptions(options);
        if (options.length > 0) setClassId(options[0].id);
        setLoading(false);
        return;
      }

      // 導師：查自己導的班級
      const { data: teacherRow } = await supabase.from('teachers').select('id').eq('app_user_id', appUser.id).maybeSingle();
      if (teacherRow) {
        const { data: cls } = await supabase
          .from('classes')
          .select('id, class_name, grade_level')
          .eq('homeroom_teacher_id', teacherRow.id)
          .maybeSingle();
        if (cls) {
          setClassId(cls.id);
          setClassName(`${cls.grade_level}${cls.class_name}`);
        }
      }
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (!classId) return;
    (async () => {
      setLoading(true);
      if (isAdmin) {
        const opt = classOptions.find((c) => c.id === classId);
        if (opt) setClassName(opt.label);
      }
      // 先查這個班目前的學期（同一個 class_id 可能同時存在上學期／下學期兩批獨立
      // 學籍列，一定要知道是哪個學期才能正確篩選、排名，理由同
      // sql/44fix_report_card_and_ranking_performance.sql 裡的說明）。
      const { data: enrollRows } = await supabase
        .from('enrollments')
        .select('term')
        .eq('class_id', classId)
        .eq('is_current', true)
        .limit(1);
      const currentTerm = (enrollRows ?? [])[0]?.term as string | undefined;

      // 改呼叫 class_rankings_for_class()（sql/44fix_report_card_and_ranking_performance.sql），
      // 一開始 join 就用 class_id 篩過，不會再因為全校資料量變大而逾時
      // （canceling statement due to statement timeout）——原本直接查 class_rankings
      // 這個 view 要等全校所有學生的排名都算完才篩選，這個班的查詢速度會被全校資料
      // 拖慢；改成呼叫這支函式後，這個班有多少學生就只算多少學生。
      const { data, error } = await supabase
        .rpc('class_rankings_for_class', { p_class_id: classId, p_term: currentTerm })
        .order('class_rank');

      setLoadError(
        error
          ? '讀取班級成績結果失敗：' + error.message
          : null
      );
      setRows((data ?? []) as RankRow[]);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId]);

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>{className || '班級'} 成績結果</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        總分＝期中35%＋期末35%＋平時30%（依各科比重加權），已套用目前啟用中的加扣分規則。
        該班「期中考」「期末考」「平時分」三項都鎖定後，這裡的總分／班排名才會出現；
        任何一項還沒鎖定，這裡會是空的（但「班級成績總表」頁面上，期中/期末/平時各自的
        小計與排名，只要該項自己鎖定就會各自顯示，不用等其他兩項）。
      </p>

      {isAdmin && (
        <select value={classId} onChange={(e) => setClassId(e.target.value)} style={{ padding: 8, marginBottom: 16, width: '100%' }}>
          {classOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      )}

      {loadError && (
        <p style={{ fontSize: 13, color: '#A32D2D', background: '#FBEEEE', border: '1px solid #E5C6C6', borderRadius: 6, padding: 12, marginBottom: 12 }}>
          {loadError}
        </p>
      )}

      {loading ? (
        <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: 6 }}>座號</th>
              <th style={{ textAlign: 'left', padding: 6 }}>姓名</th>
              <th style={{ textAlign: 'right', padding: 6 }}>總分</th>
              <th style={{ textAlign: 'right', padding: 6 }}>班排名</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.enrollment_id} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: 6 }}>{r.seat_no}</td>
                <td style={{ padding: 6 }}>{r.name}</td>
                <td style={{ padding: 6, textAlign: 'right' }}>{r.total_score}</td>
                <td style={{ padding: 6, textAlign: 'right' }}>{r.class_rank}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} style={{ padding: 12, textAlign: 'center', color: '#999' }}>
                  目前沒有資料（可能該班「期中考／期末考／平時分」還沒三項都鎖定）
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
