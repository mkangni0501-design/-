'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

type ClassOption = { id: string; label: string };

export default function TransferPage() {
  const [studentNo, setStudentNo] = useState('');
  const [studentName, setStudentName] = useState<string | null>(null);
  const [currentClassLabel, setCurrentClassLabel] = useState<string | null>(null);
  const [currentEnrollmentId, setCurrentEnrollmentId] = useState<string | null>(null);
  const [term, setTerm] = useState<string | null>(null);
  const [targetClassId, setTargetClassId] = useState('');
  const [seatNo, setSeatNo] = useState('');
  const [classes, setClasses] = useState<ClassOption[]>([]);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('classes').select('id, academic_year, department, grade_level, class_name');
      setClasses(
        (data ?? []).map((c: any) => ({
          id: c.id,
          label: `${c.academic_year} ${c.department} ${c.grade_level}${c.class_name}`,
        }))
      );
    })();
  }, []);

  async function handleLookup() {
    const { data: student } = await supabase.from('students').select('name').eq('student_no', studentNo).maybeSingle();
    setStudentName(student?.name ?? null);

    const { data: enrollRow } = await supabase
      .from('enrollments')
      .select('id, term, classes(academic_year, department, grade_level, class_name)')
      .eq('student_no', studentNo)
      .eq('is_current', true)
      .maybeSingle();

    if (enrollRow) {
      const cls: any = (enrollRow as any).classes;
      setCurrentClassLabel(`${cls.academic_year} ${cls.department} ${cls.grade_level}${cls.class_name}`);
      setCurrentEnrollmentId(enrollRow.id);
      setTerm((enrollRow as any).term);
    } else {
      setCurrentClassLabel(null);
      setCurrentEnrollmentId(null);
    }
  }

  async function handleTransfer(e: React.FormEvent) {
    e.preventDefault();
    if (!currentEnrollmentId || !term) {
      alert('請先查詢學生目前的班級');
      return;
    }
    if (!confirm(`確定要把 ${studentName} 轉到新班級嗎？原本的班級紀錄會保留為歷史紀錄。`)) return;

    await supabase.from('enrollments').update({ is_current: false }).eq('id', currentEnrollmentId);

    const { error } = await supabase.from('enrollments').insert({
      student_no: studentNo,
      class_id: targetClassId,
      term,
      seat_no: Number(seatNo),
      is_current: true,
    });
    if (error) {
      alert('轉班失敗：' + error.message);
      // 失敗的話把舊紀錄復原成現行，避免學生變成沒有班級
      await supabase.from('enrollments').update({ is_current: true }).eq('id', currentEnrollmentId);
      return;
    }
    alert('轉班完成');
    setStudentNo('');
    setStudentName(null);
    setCurrentClassLabel(null);
    setSeatNo('');
  }

  return (
    <div style={{ maxWidth: 420, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>學期中轉班</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        原本的班級紀錄不會被刪除，只會標記為非現行，歷年查詢時仍看得到這個學生曾經在哪個班待過。
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input placeholder="輸入學號" value={studentNo} onChange={(e) => setStudentNo(e.target.value)} style={{ padding: 8, flex: 1 }} />
        <button type="button" onClick={handleLookup} style={{ padding: '8px 16px' }}>
          查詢
        </button>
      </div>

      {studentName && (
        <p style={{ fontSize: 13, marginBottom: 12 }}>
          {studentName}　目前班級：{currentClassLabel ?? '（查無現行班級）'}
        </p>
      )}

      {currentEnrollmentId && (
        <form onSubmit={handleTransfer} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <select value={targetClassId} onChange={(e) => setTargetClassId(e.target.value)} style={{ padding: 8 }} required>
            <option value="">選擇新班級</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <input type="number" placeholder="新座號" value={seatNo} onChange={(e) => setSeatNo(e.target.value)} style={{ padding: 8 }} required />
          <button type="submit" style={{ padding: 12, background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 8 }}>
            確認轉班
          </button>
        </form>
      )}
    </div>
  );
}
