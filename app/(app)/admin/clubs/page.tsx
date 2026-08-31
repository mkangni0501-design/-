'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { resolveCurrentTerm } from '@/lib/academicTerm';
import { useDepartmentPermissions } from '@/lib/useDepartmentPermissions';
import { isDepartmentLead } from '@/lib/departments';

type Club = {
  id: string;
  name: string;
  academic_year: number;
  term: string;
  teacher_id: string | null;
  external_teacher_name: string | null;
  capacity: number | null;
  period_no: number | null;
  description: string | null;
  is_active: boolean;
};
type TeacherOption = { id: string; name: string };
type MemberRow = { id: string; student_no: string; status: string; name: string; class_label: string; seat_no: number | null };
type SelectionWindow = {
  id: string;
  academic_year: number;
  term: string;
  method: '志願序_第一志願優先' | '志願序_隨機亂數' | '即時搶選';
  max_choices: number | null;
  opens_at: string;
  closes_at: string | null;
  is_finalized: boolean;
  finalized_at: string | null;
};

const METHOD_LABELS: Record<SelectionWindow['method'], string> = {
  志願序_第一志願優先: '志願序抽籤（第一志願優先法）',
  志願序_隨機亂數: '志願序抽籤（隨機亂數法）',
  即時搶選: '即時搶選（先搶先贏）',
};

function toLocalInputValue(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 社團／才藝課管理（教務處後台）：建立社團＋手動指派名單，加上依原始需求文件實作的
// 「選社設定」（志願序電腦抽籤兩種邏輯／即時搶選），詳見 sql/54clubs_module.sql 開頭說明。
export default function AdminClubsPage() {
  const perms = useDepartmentPermissions();
  const canManage = perms.isSystemAdmin || isDepartmentLead(perms.myDepartments, 'academic');

  const [clubs, setClubs] = useState<Club[]>([]);
  const [teachers, setTeachers] = useState<TeacherOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedClubId, setSelectedClubId] = useState<string>('');
  const [term, setTerm] = useState<{ academic_year: number; term: string } | null>(null);

  const [form, setForm] = useState({
    name: '',
    teacher_id: '',
    external_teacher_name: '',
    capacity: '',
    period_no: '',
    description: '',
  });

  const [members, setMembers] = useState<MemberRow[]>([]);
  const [newStudentNo, setNewStudentNo] = useState('');
  const [memberError, setMemberError] = useState<string | null>(null);

  const [selectionWindow, setSelectionWindow] = useState<SelectionWindow | null>(null);
  const [windowForm, setWindowForm] = useState<{ method: SelectionWindow['method']; max_choices: string; opens_at: string; closes_at: string }>({
    method: '志願序_第一志願優先',
    max_choices: '5',
    opens_at: '',
    closes_at: '',
  });
  const [windowMsg, setWindowMsg] = useState<string | null>(null);
  const [runningLottery, setRunningLottery] = useState(false);

  useEffect(() => {
    (async () => {
      const t = await resolveCurrentTerm();
      if (!t) {
        setError('尚未設定目前生效的學年學期，請先到「學年學期中央管理主檔」設定。');
        setLoading(false);
        return;
      }
      setTerm(t);
      const [{ data: clubRows, error: clubErr }, { data: teacherRows }, { data: windowRow }] = await Promise.all([
        supabase
          .from('clubs')
          .select('id, name, academic_year, term, teacher_id, external_teacher_name, capacity, period_no, description, is_active')
          .eq('academic_year', t.academic_year)
          .eq('term', t.term)
          .order('name'),
        supabase.from('teachers').select('id, name').order('name'),
        supabase.from('club_selection_windows').select('*').eq('academic_year', t.academic_year).eq('term', t.term).maybeSingle(),
      ]);
      if (clubErr) {
        setError('讀取社團清單失敗：' + clubErr.message);
      } else {
        setClubs((clubRows ?? []) as Club[]);
      }
      setTeachers((teacherRows ?? []) as TeacherOption[]);
      if (windowRow) {
        setSelectionWindow(windowRow as SelectionWindow);
        setWindowForm({
          method: windowRow.method,
          max_choices: windowRow.max_choices ? String(windowRow.max_choices) : '5',
          opens_at: toLocalInputValue(windowRow.opens_at),
          closes_at: toLocalInputValue(windowRow.closes_at),
        });
      }
      setLoading(false);
    })();
  }, []);

  async function loadMembers(clubId: string) {
    setMemberError(null);
    const { data: memberRows, error: memberErr } = await supabase
      .from('club_members')
      .select('id, student_no, status, students(name), enrollments(seat_no, term, classes(grade_level, class_name, academic_year))')
      .eq('club_id', clubId)
      .order('student_no');
    if (memberErr) {
      setMemberError('讀取社團名單失敗：' + memberErr.message);
      return;
    }
    const rows: MemberRow[] = (memberRows ?? []).map((r: any) => {
      const enrollmentList = Array.isArray(r.enrollments) ? r.enrollments : r.enrollments ? [r.enrollments] : [];
      const currentEnrollment = term ? enrollmentList.find((e: any) => e?.term === term.term && e?.classes?.academic_year === term.academic_year) ?? null : enrollmentList[0] ?? null;
      return {
        id: r.id,
        student_no: r.student_no,
        status: r.status,
        name: r.students?.name ?? r.student_no,
        class_label: currentEnrollment ? `${currentEnrollment.classes?.grade_level ?? ''}${currentEnrollment.classes?.class_name ?? ''}` : '（查無現行學籍）',
        seat_no: currentEnrollment?.seat_no ?? null,
      };
    });
    setMembers(rows);
  }

  useEffect(() => {
    if (selectedClubId) loadMembers(selectedClubId);
    else setMembers([]);
  }, [selectedClubId]);

  async function createClub() {
    setError(null);
    if (!form.name.trim()) {
      setError('請輸入社團名稱');
      return;
    }
    if (!term) {
      setError('尚未設定目前生效的學年學期');
      return;
    }
    const { data, error: insErr } = await supabase
      .from('clubs')
      .insert({
        name: form.name.trim(),
        academic_year: term.academic_year,
        term: term.term,
        teacher_id: form.teacher_id || null,
        external_teacher_name: form.external_teacher_name.trim() || null,
        capacity: form.capacity ? Number(form.capacity) : null,
        period_no: form.period_no ? Number(form.period_no) : null,
        description: form.description.trim() || null,
      })
      .select()
      .single();
    if (insErr) {
      setError('建立社團失敗：' + insErr.message + '（同一學期社團名稱不能重複）');
      return;
    }
    setClubs((prev) => [...prev, data as Club].sort((a, b) => a.name.localeCompare(b.name)));
    setForm({ name: '', teacher_id: '', external_teacher_name: '', capacity: '', period_no: '', description: '' });
  }

  async function addMember() {
    if (!selectedClubId || !newStudentNo.trim()) return;
    setMemberError(null);
    const studentNo = newStudentNo.trim();

    const { data: studentRow } = await supabase.from('students').select('student_no').eq('student_no', studentNo).maybeSingle();
    if (!studentRow) {
      setMemberError(`查無學號 ${studentNo} 的學生資料，請確認學號是否正確`);
      return;
    }
    const club = clubs.find((c) => c.id === selectedClubId);
    if (club?.capacity != null) {
      const activeCount = members.filter((m) => m.status === '在社').length;
      if (activeCount >= club.capacity) {
        setMemberError(`「${club.name}」目前在社人數已達名額上限（${club.capacity} 人），如需超收請先調整名額設定`);
        return;
      }
    }
    const { error: insErr } = await supabase.from('club_members').insert({ club_id: selectedClubId, student_no: studentNo });
    if (insErr) {
      setMemberError('加入名單失敗：' + insErr.message + '（可能這位學生已經在名單裡了）');
      return;
    }
    setNewStudentNo('');
    loadMembers(selectedClubId);
  }

  async function toggleMemberStatus(member: MemberRow) {
    const nextStatus = member.status === '在社' ? '退社' : '在社';
    const { error: updErr } = await supabase.from('club_members').update({ status: nextStatus }).eq('id', member.id);
    if (updErr) {
      setMemberError('更新失敗：' + updErr.message);
      return;
    }
    loadMembers(selectedClubId);
  }

  async function saveSelectionWindow() {
    setWindowMsg(null);
    if (!term) return;
    if (!windowForm.opens_at) {
      setWindowMsg('請設定開放時間');
      return;
    }
    const payload = {
      academic_year: term.academic_year,
      term: term.term,
      method: windowForm.method,
      max_choices: windowForm.method === '即時搶選' ? null : windowForm.max_choices ? Number(windowForm.max_choices) : null,
      opens_at: new Date(windowForm.opens_at).toISOString(),
      closes_at: windowForm.closes_at ? new Date(windowForm.closes_at).toISOString() : null,
    };
    const { data, error: upsertErr } = await supabase.from('club_selection_windows').upsert(payload, { onConflict: 'academic_year,term' }).select().single();
    if (upsertErr) {
      setWindowMsg('儲存失敗：' + upsertErr.message);
      return;
    }
    setSelectionWindow(data as SelectionWindow);
    setWindowMsg('選社設定已儲存');
  }

  async function runLottery() {
    if (!term || !selectionWindow) return;
    if (!confirm('執行電腦抽籤會清空目前所有社團名單，改用學生填的志願序重新分發一次，確定要執行嗎？')) return;
    setRunningLottery(true);
    setWindowMsg(null);
    const fn = selectionWindow.method === '志願序_第一志願優先' ? 'run_club_lottery_priority' : 'run_club_lottery_random_number';
    const { error: rpcErr } = await supabase.rpc(fn, { p_academic_year: term.academic_year, p_term: term.term });
    if (rpcErr) {
      setWindowMsg('抽籤執行失敗：' + rpcErr.message);
    } else {
      setWindowMsg('電腦抽籤已完成，社團名單已依志願序重新分發');
      setSelectionWindow({ ...selectionWindow, is_finalized: true, finalized_at: new Date().toISOString() });
      const { data: clubRows } = await supabase
        .from('clubs')
        .select('id, name, academic_year, term, teacher_id, external_teacher_name, capacity, period_no, description, is_active')
        .eq('academic_year', term.academic_year)
        .eq('term', term.term)
        .order('name');
      setClubs((clubRows ?? []) as Club[]);
      if (selectedClubId) loadMembers(selectedClubId);
    }
    setRunningLottery(false);
  }

  if (loading) return <main style={{ padding: 24 }}>載入中…</main>;

  if (!canManage) {
    return (
      <main style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
        <h1 style={{ fontSize: 16 }}>社團／才藝課管理</h1>
        <p style={{ fontSize: 13, color: '#999' }}>此頁僅開放教務部門主管或系統管理員操作。</p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>社團／才藝課管理</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        建立社團、指派指導老師、設定選社方式。學生選好社／電腦抽籤分發完成後，社團老師可到「社團點名冊」「社團成績輸入」操作自己社團的學生。
      </p>
      {error && <p style={{ fontSize: 13, color: '#A32D2D', marginBottom: 12 }}>{error}</p>}

      <section style={{ border: '1px solid #eee', borderRadius: 8, padding: 16, marginBottom: 24 }}>
        <h2 style={{ fontSize: 14, marginBottom: 12 }}>新增社團</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <label style={{ fontSize: 12 }}>
            社團名稱
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={{ width: '100%', padding: 6, marginTop: 4 }} placeholder="例如：吉他社" />
          </label>
          <label style={{ fontSize: 12 }}>
            名額上限（選填）
            <input value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} style={{ width: '100%', padding: 6, marginTop: 4 }} placeholder="不填代表不限" />
          </label>
          <label style={{ fontSize: 12 }}>
            指導老師（校內教師）
            <select value={form.teacher_id} onChange={(e) => setForm({ ...form, teacher_id: e.target.value })} style={{ width: '100%', padding: 6, marginTop: 4 }}>
              <option value="">（未指派／外聘老師）</option>
              {teachers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 12 }}>
            外聘老師姓名（若無校內帳號）
            <input value={form.external_teacher_name} onChange={(e) => setForm({ ...form, external_teacher_name: e.target.value })} style={{ width: '100%', padding: 6, marginTop: 4 }} placeholder="僅作紀錄，尚未支援外聘登入" />
          </label>
          <label style={{ fontSize: 12 }}>
            固定上課節次（選填）
            <input
              value={form.period_no}
              onChange={(e) => setForm({ ...form, period_no: e.target.value })}
              style={{ width: '100%', padding: 6, marginTop: 4 }}
              placeholder="例如：8（第8節）；有填才會同步進全校出缺席總表"
            />
          </label>
        </div>
        <label style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
          社團簡介（選填）
          <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} style={{ width: '100%', padding: 6, marginTop: 4 }} rows={2} />
        </label>
        <button onClick={createClub} style={{ padding: '8px 16px' }}>
          建立社團
        </button>
      </section>

      <section style={{ border: '1px solid #eee', borderRadius: 8, padding: 16, marginBottom: 24 }}>
        <h2 style={{ fontSize: 14, marginBottom: 4 }}>選社設定</h2>
        <p style={{ fontSize: 12, color: '#666', marginBottom: 12 }}>
          設定這學期用哪一種方式決定學生進哪個社團。志願序類方法設定好開放時間後，學生會在「家長/學生查詢入口」看到選社頁面填志願，
          教務處確認截止後再回來這裡按「執行電腦抽籤」；即時搶選則是學生自己在開放時間內登入搶名額，不用另外按抽籤。
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <label style={{ fontSize: 12 }}>
            選社方式
            <select
              value={windowForm.method}
              onChange={(e) => setWindowForm({ ...windowForm, method: e.target.value as SelectionWindow['method'] })}
              style={{ width: '100%', padding: 6, marginTop: 4 }}
            >
              {Object.entries(METHOD_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {windowForm.method !== '即時搶選' && (
            <label style={{ fontSize: 12 }}>
              最多可填幾個志願
              <input value={windowForm.max_choices} onChange={(e) => setWindowForm({ ...windowForm, max_choices: e.target.value })} style={{ width: '100%', padding: 6, marginTop: 4 }} />
            </label>
          )}
          <label style={{ fontSize: 12 }}>
            開放時間
            <input type="datetime-local" value={windowForm.opens_at} onChange={(e) => setWindowForm({ ...windowForm, opens_at: e.target.value })} style={{ width: '100%', padding: 6, marginTop: 4 }} />
          </label>
          <label style={{ fontSize: 12 }}>
            截止時間（選填，留空＝不設限）
            <input type="datetime-local" value={windowForm.closes_at} onChange={(e) => setWindowForm({ ...windowForm, closes_at: e.target.value })} style={{ width: '100%', padding: 6, marginTop: 4 }} />
          </label>
        </div>
        {windowMsg && <p style={{ fontSize: 13, color: windowMsg.includes('失敗') ? '#A32D2D' : '#2D7A3A', marginBottom: 12 }}>{windowMsg}</p>}
        <div style={{ display: 'flex', gap: 12 }}>
          <button onClick={saveSelectionWindow} style={{ padding: '8px 16px' }}>
            儲存選社設定
          </button>
          {selectionWindow && selectionWindow.method !== '即時搶選' && (
            <button onClick={runLottery} disabled={runningLottery} style={{ padding: '8px 16px', fontWeight: 600 }}>
              {runningLottery ? '執行中…' : '執行電腦抽籤'}
            </button>
          )}
        </div>
        {selectionWindow?.is_finalized && (
          <p style={{ fontSize: 12, color: '#999', marginTop: 8 }}>
            已於 {selectionWindow.finalized_at ? new Date(selectionWindow.finalized_at).toLocaleString('zh-TW') : ''} 執行過抽籤，各社團名單可到下方「社團名單管理」查看與微調。
          </p>
        )}
      </section>

      <section style={{ border: '1px solid #eee', borderRadius: 8, padding: 16 }}>
        <h2 style={{ fontSize: 14, marginBottom: 12 }}>社團名單管理</h2>
        <select value={selectedClubId} onChange={(e) => setSelectedClubId(e.target.value)} style={{ padding: 8, marginBottom: 16, width: '100%', maxWidth: 320 }}>
          <option value="">請選擇社團</option>
          {clubs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.teacher_id ? ` － ${teachers.find((t) => t.id === c.teacher_id)?.name ?? ''}` : c.external_teacher_name ? ` － ${c.external_teacher_name}（外聘）` : ' － 尚未指派老師'}
            </option>
          ))}
        </select>

        {selectedClubId && (
          <>
            {memberError && <p style={{ fontSize: 13, color: '#A32D2D', marginBottom: 12 }}>{memberError}</p>}
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <input value={newStudentNo} onChange={(e) => setNewStudentNo(e.target.value)} placeholder="輸入學號加入社團" style={{ padding: 6, flex: 1, maxWidth: 240 }} />
              <button onClick={addMember} style={{ padding: '6px 16px' }}>
                加入
              </button>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: 6 }}>學號</th>
                  <th style={{ textAlign: 'left', padding: 6 }}>原班級</th>
                  <th style={{ textAlign: 'left', padding: 6 }}>原座號</th>
                  <th style={{ textAlign: 'left', padding: 6 }}>姓名</th>
                  <th style={{ textAlign: 'left', padding: 6 }}>狀態</th>
                  <th style={{ padding: 6 }}></th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id} style={{ borderTop: '1px solid #eee' }}>
                    <td style={{ padding: 6 }}>{m.student_no}</td>
                    <td style={{ padding: 6 }}>{m.class_label}</td>
                    <td style={{ padding: 6 }}>{m.seat_no ?? '－'}</td>
                    <td style={{ padding: 6 }}>{m.name}</td>
                    <td style={{ padding: 6 }}>{m.status}</td>
                    <td style={{ padding: 6 }}>
                      <button onClick={() => toggleMemberStatus(m)} style={{ padding: '2px 10px', fontSize: 12 }}>
                        {m.status === '在社' ? '設為退社' : '恢復在社'}
                      </button>
                    </td>
                  </tr>
                ))}
                {members.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ padding: 12, textAlign: 'center', color: '#999' }}>
                      目前還沒有學生加入這個社團
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </>
        )}
      </section>
    </main>
  );
}
