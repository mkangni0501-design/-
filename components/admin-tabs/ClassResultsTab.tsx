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
      // class_rankings 這個 view 已經算好加權總分與排名（含目前啟用中的加扣分規則）
      const { data, error } = await supabase
        .from('class_rankings')
        .select('enrollment_id, seat_no, name, total_score, class_rank')
        .eq('class_id', classId)
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
        總分＝期中35%＋期末35%＋平時30%（依各科比重加權），已套用目前啟用中的加扣分規則。若該班「平時分」尚未鎖定，這裡會是空的。
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
                  目前沒有資料（可能該班平時分尚未鎖定）
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
