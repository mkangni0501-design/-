'use client';

import { useEffect, useState } from 'react';
import { supabase, getCurrentAppUser, getCurrentTeacherId, isAdminInCurrentView } from '@/lib/supabaseClient';
import { getHiddenStudentNos } from '@/lib/hiddenStudents';
import ErrorBanner from '@/components/ErrorBanner';

type ClassOption = {
  id: string;
  label: string;
  academic_year: number;
  grade_level: string;
  class_name: string;
  homeroom_teacher_id: string | null;
};

type GuardianPhone = { relation: string; name: string | null; phone: string | null };
type RosterRow = {
  id: string;
  student_no: string;
  seat_no: number | null;
  students?: { name: string; gender: string | null } | null;
};

type StudentDetail = {
  student_no: string;
  name: string;
  gender: string | null;
  thai_name: string | null;
  dob: string | null;
  id_number: string | null;
  nationality: string | null;
  religion: string | null;
  blood_type: string | null;
  address: string | null;
  phone: string | null;
  previous_school: string | null;
  previous_school_grade: string | null;
};

const DETAIL_FIELDS: { key: keyof StudentDetail; label: string }[] = [
  { key: 'gender', label: '性別' },
  { key: 'thai_name', label: '泰文姓名' },
  { key: 'dob', label: '出生日期' },
  { key: 'id_number', label: '身分證/護照號碼' },
  { key: 'nationality', label: '國籍' },
  { key: 'religion', label: '宗教' },
  { key: 'blood_type', label: '血型' },
  { key: 'address', label: '地址' },
  { key: 'phone', label: '電話' },
  { key: 'previous_school', label: '原就讀學校' },
  { key: 'previous_school_grade', label: '原就讀年級' },
];

// 學生名冊：跟「查詢學生」不同，這裡刻意做成「先選班級、只看座號/學號/姓名」的簡單清單，
// 方便要點名、要核對座位表的人快速掃過一個班級，不用先面對全校清單或編輯表單。
// 點一列會展開該生的資料——但「看得到多少」依身分分流：只有系統管理員／該班導師
// 能看到完整個人資料；其他教師點開只看得到監護人電話，避免任何教師都能看到全校
// 學生的身分證字號、地址等個資（見 sql/83fix_roster_pii_exposure.sql）。
export default function StudentsRosterTab() {
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [classId, setClassId] = useState('');
  const [rows, setRows] = useState<RosterRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [isAdmin, setIsAdmin] = useState(false);
  const [myTeacherId, setMyTeacherId] = useState<string | null>(null);

  const [openStudentNo, setOpenStudentNo] = useState<string | null>(null);
  const [detail, setDetail] = useState<StudentDetail | null>(null);
  const [guardianPhones, setGuardianPhones] = useState<GuardianPhone[] | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    (async () => {
      const appUser = await getCurrentAppUser();
      if (appUser) setIsAdmin(isAdminInCurrentView(appUser.role));
      setMyTeacherId(await getCurrentTeacherId());

      const { data, error } = await supabase
        .from('classes')
        .select('id, academic_year, grade_level, class_name, homeroom_teacher_id')
        .order('academic_year', { ascending: false })
        .order('grade_level')
        .order('class_name');
      if (error) {
        setLoadError('讀取班級清單失敗：' + error.message);
        return;
      }
      const options = (data ?? []).map((c: any) => ({
        id: c.id,
        label: `${c.academic_year} ${c.grade_level}${c.class_name}`,
        academic_year: c.academic_year,
        grade_level: c.grade_level,
        class_name: c.class_name,
        homeroom_teacher_id: c.homeroom_teacher_id ?? null,
      }));
      setClasses(options);
      if (options.length > 0) setClassId(options[0].id);
    })();
  }, []);

  // 目前選到的班級，我是不是這班的導師（或系統管理員／管理視角）——決定點開學生
  // 之後看得到完整個人資料、還是只看得到監護人電話。
  const selectedClass = classes.find((c) => c.id === classId) ?? null;
  const canSeeFullDetail = isAdmin || (!!myTeacherId && !!selectedClass && selectedClass.homeroom_teacher_id === myTeacherId);

  useEffect(() => {
    if (!classId) {
      setRows([]);
      return;
    }
    (async () => {
      setLoading(true);
      setOpenStudentNo(null);
      const { data, error } = await supabase
        .from('enrollments')
        .select('id, student_no, seat_no, students(name, gender)')
        .eq('class_id', classId)
        .eq('is_current', true)
        .order('seat_no');
      setLoadError(error ? '讀取學生名冊失敗：' + error.message : null);
      // 【本輪新增】反映事項「休學/轉學/退學的學生，只能在管理者視角下看到，
      // 其他視角皆無法顯示」——理由見 lib/hiddenStudents.ts 的說明（管理員切換
      // 成「教師視角」預覽時，RLS 不會過濾隱藏名單，這裡在前端補一層過濾）。
      const hiddenNos = isAdmin ? new Set<string>() : await getHiddenStudentNos((data ?? []).map((r: any) => r.student_no));
      const visibleRows = (data ?? []).filter((r: any) => !hiddenNos.has(r.student_no));
      setRows(visibleRows as unknown as RosterRow[]);
      setLoading(false);
    })();
  }, [classId, isAdmin]);

  async function toggleOpen(studentNo: string) {
    if (openStudentNo === studentNo) {
      setOpenStudentNo(null);
      return;
    }
    setOpenStudentNo(studentNo);
    setDetail(null);
    setGuardianPhones(null);
    setDetailError(null);
    setDetailLoading(true);

    if (canSeeFullDetail) {
      const { data, error } = await supabase
        .from('students')
        .select(
          'student_no, name, gender, thai_name, dob, id_number, nationality, religion, blood_type, address, phone, previous_school, previous_school_grade'
        )
        .eq('student_no', studentNo)
        .single();
      setDetailLoading(false);
      if (error) {
        setDetailError('讀取學生個人資料失敗：' + error.message);
        return;
      }
      setDetail(data as StudentDetail);
      return;
    }

    // 不是這班導師（也不是管理員）：只給監護人電話，不查、不顯示其他個人資料。
    const { data, error } = await supabase.rpc('guardian_phones_for_roster', { p_student_no: studentNo });
    setDetailLoading(false);
    if (error) {
      setDetailError('讀取監護人電話失敗：' + error.message);
      return;
    }
    setGuardianPhones((data ?? []) as GuardianPhone[]);
  }

  return (
    <div style={{ maxWidth: 700, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>學生名冊</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        選一個班級，直接看目前在學學生的座號、學號、姓名。點任一列可展開該生的個人資料（唯讀）；
        要修改資料請到「學籍設定及查詢→查詢學生」。
      </p>
      <ErrorBanner message={loadError} />

      <select value={classId} onChange={(e) => setClassId(e.target.value)} style={{ padding: 8, minWidth: 220, marginBottom: 12 }}>
        {classes.length === 0 && <option value="">（無班級資料）</option>}
        {classes.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>

      <p style={{ fontSize: 12, color: '#999', marginBottom: 8 }}>{loading ? '讀取中…' : `共 ${rows.length} 位學生`}</p>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #ddd' }}>
            <th style={{ textAlign: 'right', padding: 6, width: 60 }}>座號</th>
            <th style={{ textAlign: 'left', padding: 6, width: 120 }}>學號</th>
            <th style={{ textAlign: 'left', padding: 6 }}>姓名</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <>
              <tr
                key={r.id}
                onClick={() => toggleOpen(r.student_no)}
                style={{ borderTop: '1px solid #eee', cursor: 'pointer', background: openStudentNo === r.student_no ? '#F7F5EF' : 'transparent' }}
              >
                <td style={{ padding: 6, textAlign: 'right' }}>{r.seat_no ?? '—'}</td>
                <td style={{ padding: 6 }}>{r.student_no}</td>
                <td style={{ padding: 6 }}>{r.students?.name ?? '—'}</td>
              </tr>
              {openStudentNo === r.student_no && (
                <tr key={r.id + '-detail'} style={{ background: '#FBFAF6' }}>
                  <td colSpan={3} style={{ padding: '10px 16px' }}>
                    {detailLoading && <p style={{ fontSize: 12, color: '#999' }}>讀取中…</p>}
                    {detailError && <p style={{ fontSize: 12, color: '#A32D2D' }}>{detailError}</p>}
                    {detail && (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 24px', fontSize: 12 }}>
                        {DETAIL_FIELDS.map(({ key, label }) => (
                          <div key={key}>
                            <span style={{ color: '#999' }}>{label}：</span>
                            {detail[key] || '—'}
                          </div>
                        ))}
                      </div>
                    )}
                    {guardianPhones && (
                      <div style={{ fontSize: 12 }}>
                        <p style={{ color: '#999', marginBottom: 4 }}>
                          您不是這位學生的導師，僅顯示監護人電話；完整個人資料請洽該生導師。
                        </p>
                        {guardianPhones.length === 0 ? (
                          <p>（目前沒有登記監護人電話）</p>
                        ) : (
                          guardianPhones.map((g, i) => (
                            <div key={i}>
                              {g.relation}
                              {g.name ? `（${g.name}）` : ''}：{g.phone || '—'}
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              )}
            </>
          ))}
        </tbody>
      </table>
    </div>
  );
}
