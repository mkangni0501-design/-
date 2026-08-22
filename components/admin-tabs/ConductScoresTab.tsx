'use client';

import { useEffect, useState } from 'react';
import { supabase, getCurrentAppUser, isAdminInCurrentView } from '@/lib/supabaseClient';
import { useIsMobile } from '@/lib/useIsMobile';

// 操行成績「禮貌／衣著／服務／紀律」四個分項評分——依你的確認新增的評分介面
// （原本系統完全沒有地方可以輸入這四個分項，只有導師本人／管理員能看/改，
// 對應 sql/44fix_report_card_and_ranking_performance.sql 新增的 conduct_scores 表，
// RLS 規則跟「導師評語」完全一樣）。
// 「操行成績」本身＝四個分項的平均，不用另外輸入，畫面上即時算給你看，成績單上
// 也是用同樣的算法（見 lib/reportCard.ts）。

type ClassOption = { id: string; label: string };
type Row = {
  enrollment_id: string;
  seat_no: number;
  name: string;
  politeness: string;
  dress: string;
  service: string;
  discipline: string;
};

export default function ConductScoresTab() {
  const isMobile = useIsMobile();
  const [isAdmin, setIsAdmin] = useState(false);
  const [homeroomClassId, setHomeroomClassId] = useState<string | null>(null);
  const [classOptions, setClassOptions] = useState<ClassOption[]>([]);
  const [classId, setClassId] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // 操行成績可以直接按 ENTER 換下一個輸入框（往右：禮貌→衣著→服務→紀律，
  // 到最後一格再按 ENTER 換下一位學生的禮貌欄），不用每次都用滑鼠點下一格。
  const inputRefs = useState(() => new Map<string, HTMLInputElement | null>())[0];
  const FIELDS = ['politeness', 'dress', 'service', 'discipline'] as const;
  function focusNext(rowIndex: number, fieldIndex: number) {
    let nextRow = rowIndex;
    let nextField = fieldIndex + 1;
    if (nextField >= FIELDS.length) {
      nextField = 0;
      nextRow += 1;
    }
    const target = rows[nextRow];
    if (!target) return;
    const el = inputRefs.get(`${target.enrollment_id}-${FIELDS[nextField]}`);
    if (el) {
      el.focus();
      el.select();
    }
  }

  useEffect(() => {
    (async () => {
      const appUser = await getCurrentAppUser();
      if (!appUser) return;
      const admin = isAdminInCurrentView(appUser.role);
      setIsAdmin(admin);

      const { data: teacherRow } = await supabase.from('teachers').select('id').eq('app_user_id', appUser.id).maybeSingle();
      let homeroomId: string | null = null;
      if (teacherRow) {
        const { data: homeroomClass } = await supabase
          .from('classes')
          .select('id')
          .eq('homeroom_teacher_id', teacherRow.id)
          .order('academic_year', { ascending: false })
          .limit(1)
          .maybeSingle();
        homeroomId = homeroomClass?.id ?? null;
        setHomeroomClassId(homeroomId);
      }

      if (admin) {
        const { data: classRows } = await supabase
          .from('classes')
          .select('id, academic_year, grade_level, class_name')
          .order('academic_year', { ascending: false })
          .order('grade_level')
          .order('class_name');
        setClassOptions((classRows ?? []).map((c: any) => ({ id: c.id, label: `${c.academic_year} ${c.grade_level}${c.class_name}班` })));
      } else if (homeroomId) {
        const { data: cls } = await supabase.from('classes').select('id, academic_year, grade_level, class_name').eq('id', homeroomId).single();
        setClassOptions(cls ? [{ id: cls.id, label: `${cls.academic_year} ${cls.grade_level}${cls.class_name}班` }] : []);
        setClassId(homeroomId);
      }
    })();
  }, []);

  useEffect(() => {
    if (!classId) {
      setRows([]);
      return;
    }
    (async () => {
      setLoading(true);
      const { data: enrollRows } = await supabase
        .from('enrollments')
        .select('id, seat_no, student_no')
        .eq('class_id', classId)
        .order('seat_no');
      const studentNos = (enrollRows ?? []).map((r: any) => r.student_no);
      const { data: studentRows } = await supabase
        .from('students')
        .select('student_no, name')
        .in('student_no', studentNos.length > 0 ? studentNos : ['__none__']);
      const nameByNo = new Map((studentRows ?? []).map((s: any) => [s.student_no, s.name]));

      const enrollIds = (enrollRows ?? []).map((r: any) => r.id);
      const { data: conductRows } = await supabase
        .from('conduct_scores')
        .select('enrollment_id, politeness, dress, service, discipline')
        .in('enrollment_id', enrollIds.length > 0 ? enrollIds : ['00000000-0000-0000-0000-000000000000']);
      const conductByEnrollment = new Map((conductRows ?? []).map((c: any) => [c.enrollment_id, c]));

      setRows(
        (enrollRows ?? []).map((r: any) => {
          const c = conductByEnrollment.get(r.id);
          return {
            enrollment_id: r.id,
            seat_no: r.seat_no,
            name: nameByNo.get(r.student_no) ?? '（找不到姓名）',
            politeness: c?.politeness ?? '',
            dress: c?.dress ?? '',
            service: c?.service ?? '',
            discipline: c?.discipline ?? '',
          };
        })
      );
      setLoading(false);
    })();
  }, [classId]);

  function updateField(enrollmentId: string, field: 'politeness' | 'dress' | 'service' | 'discipline', value: string) {
    setRows((prev) => prev.map((r) => (r.enrollment_id === enrollmentId ? { ...r, [field]: value } : r)));
  }

  function average(r: Row): string {
    const nums = [r.politeness, r.dress, r.service, r.discipline].map((v) => (v === '' ? null : Number(v))).filter((v): v is number => v !== null && !Number.isNaN(v));
    if (nums.length === 0) return '';
    return (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(1);
  }

  async function handleSaveAll() {
    setSaving(true);
    const payload = rows
      .filter((r) => r.politeness !== '' || r.dress !== '' || r.service !== '' || r.discipline !== '')
      .map((r) => ({
        enrollment_id: r.enrollment_id,
        politeness: r.politeness === '' ? null : Number(r.politeness),
        dress: r.dress === '' ? null : Number(r.dress),
        service: r.service === '' ? null : Number(r.service),
        discipline: r.discipline === '' ? null : Number(r.discipline),
      }));
    if (payload.length === 0) {
      setSaving(false);
      return;
    }
    const { error } = await supabase.from('conduct_scores').upsert(payload, { onConflict: 'enrollment_id' });
    setSaving(false);
    if (error) {
      alert('儲存失敗：' + error.message);
    } else {
      alert('已儲存');
    }
  }

  if (!isAdmin && !homeroomClassId) {
    return <p style={{ fontSize: 13, color: '#999' }}>操行成績評分只有導師本人與管理員可以使用，你目前不是任何班級的導師。</p>;
  }

  return (
    <div>
      <h2 style={{ fontSize: 13, color: '#666', marginBottom: 8 }}>
        操行成績「禮貌／衣著／服務／紀律」四個分項評分（只有本人與管理員看得到，任課教師不可見）
      </h2>
      {isAdmin && (
        <select value={classId} onChange={(e) => setClassId(e.target.value)} style={{ padding: isMobile ? 10 : 6, fontSize: isMobile ? 15 : 13, marginBottom: 12 }}>
          <option value="">請選擇班級</option>
          {classOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      )}

      {loading && <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>}

      {!loading && rows.length > 0 && (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f5f5f5' }}>
                {['座號', '姓名', '禮貌', '衣著', '服務', '紀律', '操行成績（自動平均）'].map((h) => (
                  <th key={h} style={{ border: '1px solid #ddd', padding: 6, textAlign: 'left' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, rowIndex) => (
                <tr key={r.enrollment_id}>
                  <td style={{ border: '1px solid #eee', padding: 6 }}>{r.seat_no}</td>
                  <td style={{ border: '1px solid #eee', padding: 6 }}>{r.name}</td>
                  {FIELDS.map((field, fieldIndex) => (
                    <td key={field} style={{ border: '1px solid #eee', padding: 4 }}>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={r[field]}
                        ref={(el) => {
                          inputRefs.set(`${r.enrollment_id}-${field}`, el);
                        }}
                        onChange={(e) => updateField(r.enrollment_id, field, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            focusNext(rowIndex, fieldIndex);
                          }
                        }}
                        style={{ width: 56, padding: 4, fontSize: 13 }}
                      />
                    </td>
                  ))}
                  <td style={{ border: '1px solid #eee', padding: 6, color: '#666' }}>{average(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            onClick={handleSaveAll}
            disabled={saving}
            style={{ marginTop: 12, padding: '8px 20px', background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13 }}
          >
            {saving ? '儲存中…' : '儲存全部'}
          </button>
        </>
      )}
      {!loading && classId && rows.length === 0 && <p style={{ fontSize: 13, color: '#999' }}>這個班級目前沒有在學學生。</p>}
    </div>
  );
}
