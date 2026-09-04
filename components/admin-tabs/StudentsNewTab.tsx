'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

type ClassOption = { id: string; label: string };

const emptyStudent = {
  student_no: '',
  name: '',
  thai_name: '',
  gender: '',
  dob: '',
  id_number: '',
  nationality: '',
  religion: '',
  blood_type: '',
  address: '',
  phone: '',
  previous_school: '',
  previous_school_grade: '',
};

const emptyGuardian = { relation: '父親', name: '', chinese_name: '', occupation: '', phone: '', email: '', address: '' };

// 完整版：對照紙本《新生入學申請表》的所有欄位，給真正的新生登記使用。
export default function NewStudentRegistrationPage() {
  const [student, setStudent] = useState(emptyStudent);
  const [guardians, setGuardians] = useState([{ ...emptyGuardian }]);
  const [classId, setClassId] = useState('');
  const [term, setTerm] = useState('上學期');
  const [seatNo, setSeatNo] = useState('');
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [admissionFiles, setAdmissionFiles] = useState<FileList | null>(null);

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

  function updateGuardian(index: number, patch: Partial<typeof emptyGuardian>) {
    setGuardians((prev) => prev.map((g, i) => (i === index ? { ...g, ...patch } : g)));
  }

  function addGuardian() {
    setGuardians((prev) => [...prev, { ...emptyGuardian, relation: '監護人' }]);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const { error: studentError } = await supabase.from('students').insert({
      student_no: student.student_no,
      name: student.name,
      thai_name: student.thai_name || null,
      gender: student.gender || null,
      dob: student.dob || null,
      id_number: student.id_number || null,
      nationality: student.nationality || null,
      religion: student.religion || null,
      blood_type: student.blood_type || null,
      address: student.address || null,
      phone: student.phone || null,
      previous_school: student.previous_school || null,
      previous_school_grade: student.previous_school_grade || null,
    });
    if (studentError) {
      alert('建立學生資料失敗：' + studentError.message);
      return;
    }

    for (const g of guardians) {
      if (!g.name) continue;
      await supabase.from('guardians').insert({ student_no: student.student_no, ...g });
    }

    const { error: enrollError } = await supabase.from('enrollments').insert({
      student_no: student.student_no,
      class_id: classId,
      term,
      seat_no: Number(seatNo),
    });
    if (enrollError) {
      alert('建立學籍失敗：' + enrollError.message);
      return;
    }

    // 新生入學，狀態歷程從「入學」開始
    const { data: statusRow, error: statusError } = await supabase
      .from('student_status_changes')
      .insert({
        student_no: student.student_no,
        status: '入學',
        effective_date: new Date().toISOString().slice(0, 10),
        reason: '新生入學',
      })
      .select('id')
      .single();

    if (statusError || !statusRow) {
      alert('學籍狀態建立失敗：' + statusError?.message);
      return;
    }

    // 上傳已簽名的入學申請書PDF（掃描檔），自動歸檔到這位學生的資料中
    if (admissionFiles && admissionFiles.length > 0) {
      for (const file of Array.from(admissionFiles)) {
        const path = `status-changes/${statusRow.id}/${file.name}`;
        const { error: uploadError } = await supabase.storage.from('student-documents').upload(path, file);
        if (uploadError) {
          alert(`檔案「${file.name}」上傳失敗：${uploadError.message}`);
          continue;
        }
        await supabase.from('status_change_attachments').insert({
          status_change_id: statusRow.id,
          file_url: path,
          file_name: file.name,
        });
      }
    }

    alert('已完成新生登記');
    setStudent(emptyStudent);
    setGuardians([{ ...emptyGuardian }]);
    setSeatNo('');
    setAdmissionFiles(null);
  }

  const inputStyle = { padding: 8, width: '100%' };
  const fieldWrap = { display: 'flex', flexDirection: 'column' as const, gap: 4, fontSize: 13 };

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>新生入學登記（完整版）</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 20 }}>
        對照紙本《新生入學申請表》欄位。若只是既有學生轉入，改用「既有學生快速建檔」即可，不需要填這麼多欄位。
      </p>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <section>
          <h2 style={{ fontSize: 14, marginBottom: 8 }}>學生資料</h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <label style={fieldWrap}>
              學號
              <input style={inputStyle} value={student.student_no} onChange={(e) => setStudent({ ...student, student_no: e.target.value })} required />
            </label>
            <label style={fieldWrap}>
              性別
              <input style={inputStyle} value={student.gender} onChange={(e) => setStudent({ ...student, gender: e.target.value })} />
            </label>
            <label style={fieldWrap}>
              中文姓名
              <input style={inputStyle} value={student.name} onChange={(e) => setStudent({ ...student, name: e.target.value })} required />
            </label>
            <label style={fieldWrap}>
              泰文姓名
              <input style={inputStyle} value={student.thai_name} onChange={(e) => setStudent({ ...student, thai_name: e.target.value })} />
            </label>
            <label style={fieldWrap}>
              出生日期
              <input type="date" style={inputStyle} value={student.dob} onChange={(e) => setStudent({ ...student, dob: e.target.value })} />
            </label>
            <label style={fieldWrap}>
              身分證／護照號碼
              <input style={inputStyle} value={student.id_number} onChange={(e) => setStudent({ ...student, id_number: e.target.value })} />
            </label>
            <label style={fieldWrap}>
              國籍
              <input style={inputStyle} value={student.nationality} onChange={(e) => setStudent({ ...student, nationality: e.target.value })} />
            </label>
            <label style={fieldWrap}>
              宗教
              <input style={inputStyle} value={student.religion} onChange={(e) => setStudent({ ...student, religion: e.target.value })} />
            </label>
            <label style={fieldWrap}>
              血型
              <input style={inputStyle} value={student.blood_type} onChange={(e) => setStudent({ ...student, blood_type: e.target.value })} />
            </label>
            <label style={fieldWrap}>
              聯絡電話
              <input style={inputStyle} value={student.phone} onChange={(e) => setStudent({ ...student, phone: e.target.value })} />
            </label>
            <label style={{ ...fieldWrap, gridColumn: '1 / -1' }}>
              現居地址
              <input style={inputStyle} value={student.address} onChange={(e) => setStudent({ ...student, address: e.target.value })} />
            </label>
            <label style={fieldWrap}>
              原就讀學校
              <input style={inputStyle} value={student.previous_school} onChange={(e) => setStudent({ ...student, previous_school: e.target.value })} />
            </label>
            <label style={fieldWrap}>
              原年級／離校概況
              <input
                style={inputStyle}
                value={student.previous_school_grade}
                onChange={(e) => setStudent({ ...student, previous_school_grade: e.target.value })}
              />
            </label>
          </div>
        </section>

        <section>
          <h2 style={{ fontSize: 14, marginBottom: 8 }}>家長／監護人資料</h2>
          {guardians.map((g, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid #eee' }}>
              <label style={fieldWrap}>
                關係
                <select style={inputStyle} value={g.relation} onChange={(e) => updateGuardian(i, { relation: e.target.value })}>
                  <option value="父親">父親</option>
                  <option value="母親">母親</option>
                  <option value="監護人">監護人</option>
                </select>
              </label>
              <label style={fieldWrap}>
                姓名
                <input style={inputStyle} value={g.name} onChange={(e) => updateGuardian(i, { name: e.target.value })} />
              </label>
              <label style={fieldWrap}>
                中文姓名
                <input style={inputStyle} value={g.chinese_name} onChange={(e) => updateGuardian(i, { chinese_name: e.target.value })} />
              </label>
              <label style={fieldWrap}>
                職業
                <input style={inputStyle} value={g.occupation} onChange={(e) => updateGuardian(i, { occupation: e.target.value })} />
              </label>
              <label style={fieldWrap}>
                聯絡電話
                <input style={inputStyle} value={g.phone} onChange={(e) => updateGuardian(i, { phone: e.target.value })} />
              </label>
              <label style={fieldWrap}>
                信箱（供日後開通查詢帳號用）
                <input type="email" style={inputStyle} value={g.email} onChange={(e) => updateGuardian(i, { email: e.target.value })} />
              </label>
              <label style={fieldWrap}>
                地址
                <input style={inputStyle} value={g.address} onChange={(e) => updateGuardian(i, { address: e.target.value })} />
              </label>
            </div>
          ))}
          <button type="button" onClick={addGuardian} style={{ fontSize: 13, padding: '4px 10px' }}>
            + 新增一位監護人
          </button>
        </section>

        <section>
          <h2 style={{ fontSize: 14, marginBottom: 8 }}>編班</h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <select style={inputStyle} value={classId} onChange={(e) => setClassId(e.target.value)} required>
              <option value="">選擇班級</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <select style={inputStyle} value={term} onChange={(e) => setTerm(e.target.value)}>
              <option value="上學期">上學期</option>
              <option value="下學期">下學期</option>
            </select>
            <input type="number" placeholder="座號" style={inputStyle} value={seatNo} onChange={(e) => setSeatNo(e.target.value)} required />
          </div>
        </section>

        <section>
          <h2 style={{ fontSize: 14, marginBottom: 8 }}>入學申請書（簽名掃描檔）</h2>
          <p style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>
            <a href="/templates/入學申請書.docx" download style={{ color: '#2C6E9E' }}>
              ↓ 下載入學申請書範本（Word）
            </a>
            ，列印給家長/學生簽名後掃描成PDF，於下方上傳，會自動歸檔到這位學生的資料中。
          </p>
          <input type="file" multiple accept="application/pdf" onChange={(e) => setAdmissionFiles(e.target.files)} />
        </section>

        <button type="submit" style={{ padding: 12, background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 8 }}>
          完成登記
        </button>
      </form>
    </div>
  );
}
