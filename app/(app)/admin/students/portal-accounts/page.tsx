'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

type GuardianOption = { relation: string; email: string | null };

export default function PortalAccountsPage() {
  const [studentNo, setStudentNo] = useState('');
  const [email, setEmail] = useState('');
  const [relation, setRelation] = useState('家長');
  const [guardianOptions, setGuardianOptions] = useState<GuardianOption[]>([]);
  const [createdCode, setCreatedCode] = useState<string | null>(null);

  // 學號輸入完離開欄位時，把該生監護人資料裡已經登記的信箱抓出來，點一下就能帶入，不用重打
  async function handleLookupGuardians() {
    if (!studentNo) return;
    const { data } = await supabase.from('guardians').select('relation, email').eq('student_no', studentNo);
    setGuardianOptions(((data ?? []) as GuardianOption[]).filter((g) => g.email));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const loginCode = `HY${studentNo}`.toUpperCase();
    const { error } = await supabase.from('portal_accounts').insert({
      student_no: studentNo,
      email,
      relation,
      login_code: loginCode,
    });
    if (error) {
      alert('建立失敗：' + error.message);
      return;
    }
    setCreatedCode(loginCode);
    setStudentNo('');
    setEmail('');
    setGuardianOptions([]);
  }

  return (
    <main style={{ maxWidth: 420, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>建立家長／學生登入帳號</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        登入代碼會自動產生為「HY+學號」，請把代碼跟登記的信箱一起告訴家長，登入時兩者都要對得上。
      </p>

      <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input
          placeholder="學號"
          value={studentNo}
          onChange={(e) => setStudentNo(e.target.value)}
          onBlur={handleLookupGuardians}
          style={{ padding: 8 }}
          required
        />

        {guardianOptions.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {guardianOptions.map((g, i) => (
              <button
                key={i}
                type="button"
                onClick={() => {
                  setEmail(g.email!);
                  setRelation(g.relation);
                }}
                style={{ fontSize: 12, padding: '4px 10px' }}
              >
                帶入{g.relation}信箱（{g.email}）
              </button>
            ))}
          </div>
        )}

        <input
          type="email"
          placeholder="家長／學生的信箱"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ padding: 8 }}
          required
        />
        <select value={relation} onChange={(e) => setRelation(e.target.value)} style={{ padding: 8 }}>
          <option value="家長">家長</option>
          <option value="學生本人">學生本人</option>
        </select>
        <button type="submit" style={{ padding: 12, background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 8 }}>
          建立帳號
        </button>
      </form>

      {createdCode && (
        <p style={{ marginTop: 16, fontSize: 14, padding: 12, background: '#EAF3DE', borderRadius: 8 }}>
          已建立，登入代碼是 <b>{createdCode}</b>，請連同登記的信箱一起告訴家長。
        </p>
      )}
    </main>
  );
}
