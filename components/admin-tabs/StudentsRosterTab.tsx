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

  // 【本輪新增】反映事項「學生名冊增加從學號或姓名查找相關班級、學號功能」——
  // 原本只能先選班級才看得到名單，要找「某個學生在哪一班」完全沒辦法。加一個
  // 搜尋框，輸入學號或姓名的一部分就查，查出來的結果本來就只會有這個登入身分
  // 看得到的（RLS 跟班級下拉選單是同一套規則，教師只查得到自己班/有教過的
  // 學生，不會因為多了搜尋框而多看到不該看的人）；點查詢結果會直接切換班級
  // 下拉選單、展開那位學生。
  const [searchKeyword, setSearchKeyword] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<
    { student_no: string; name: string; classId: string | null; classLabel: string | null; seatNo: number | null }[] | null
  >(null);

  async function handleSearchStudent() {
    const kw = searchKeyword.trim();
    if (!kw) {
      setSearchResults(null);
      return;
    }
    setSearching(true);
    setSearchError(null);
    const { data: studs, error } = await supabase
      .from('students')
      .select('student_no, name')
      .or(`student_no.ilike.%${kw}%,name.ilike.%${kw}%`)
      .limit(30);
    if (error) {
      setSearchError('查詢失敗：' + error.message);
      setSearching(false);
      return;
    }
    const nos = (studs ?? []).map((s: any) => s.student_no);
    if (nos.length === 0) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    const { data: enroll } = await supabase
      .from('enrollments')
      .select('student_no, seat_no, class_id, classes(academic_year, grade_level, class_name)')
      .in('student_no', nos)
      .eq('is_current', true);
    const results = (studs ?? []).map((s: any) => {
      const e: any = (enroll ?? []).find((r: any) => r.student_no === s.student_no);
      return {
        student_no: s.student_no,
        name: s.name,
        classId: e?.class_id ?? null,
        classLabel: e ? `${e.classes?.academic_year ?? ''} ${e.classes?.grade_level ?? ''}${e.classes?.class_name ?? ''}` : null,
        seatNo: e?.seat_no ?? null,
      };
    });
    setSearchResults(results);
    setSearching(false);
  }

  const [pendingOpenStudentNo, setPendingOpenStudentNo] = useState<string | null>(null);

  function handlePickSearchResult(r: { student_no: string; classId: string | null }) {
    if (!r.classId) return;
    setClassId(r.classId);
    setSearchResults(null);
    setSearchKeyword('');
    // 換班級後 rows 要重新載入（見下面那個依 classId 觸發的 useEffect），
    // 這裡先記住「換班級完成後要展開誰」，等 rows 真的載好了再展開，
    // 不要直接呼叫 toggleOpen——這時候 rows 可能還是舊班級的資料。
    setPendingOpenStudentNo(r.student_no);
  }

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

  // 從搜尋結果切換班級後，rows 真的載好了（且確實包含那位學生）才展開他，
  // 避免在舊班級的 rows 上誤判、或對一個還沒出現在清單裡的學號展開。
  useEffect(() => {
    if (!pendingOpenStudentNo) return;
    if (rows.some((r) => r.student_no === pendingOpenStudentNo)) {
      toggleOpen(pendingOpenStudentNo);
      setPendingOpenStudentNo(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, pendingOpenStudentNo]);

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

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input
          placeholder="輸入學號或姓名查詢班級"
          value={searchKeyword}
          onChange={(e) => setSearchKeyword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearchStudent()}
          style={{ padding: 8, flex: 1, maxWidth: 260 }}
        />
        <button onClick={handleSearchStudent} disabled={searching} style={{ padding: '8px 14px' }}>
          {searching ? '查詢中…' : '查詢'}
        </button>
      </div>
      {searchError && <p style={{ fontSize: 12, color: '#A32D2D', marginBottom: 8 }}>{searchError}</p>}
      {searchResults && (
        <div style={{ border: '1px solid #e5e5e0', borderRadius: 6, padding: 10, marginBottom: 16, maxHeight: 220, overflowY: 'auto' }}>
          {searchResults.length === 0 ? (
            <p style={{ fontSize: 12, color: '#999' }}>查無符合的學生（您看不到的學生也不會出現在結果裡）。</p>
          ) : (
            searchResults.map((r) => (
              <div
                key={r.student_no}
                onClick={() => handlePickSearchResult(r)}
                style={{
                  padding: '6px 4px',
                  fontSize: 13,
                  borderTop: '1px solid #eee',
                  cursor: r.classId ? 'pointer' : 'default',
                  color: r.classId ? '#2C2C2A' : '#999',
                }}
              >
                {r.name}（{r.student_no}）— {r.classLabel ? `${r.classLabel}　${r.seatNo ?? '—'} 號` : '目前沒有在學班級資料'}
              </div>
            ))
          )}
        </div>
      )}

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
