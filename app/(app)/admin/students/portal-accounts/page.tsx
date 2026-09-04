'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

type GuardianRow = { relation: string; name: string | null; phone: string | null };
type LookupResult = {
  studentNo: string;
  studentName: string | null;
  studentPhone: string | null;
  guardians: GuardianRow[];
  hyLinked: boolean;
  hysLinked: boolean;
};

// 【2026-08-28 改版】原本這頁是給校務人員「手動幫每個學生建立家長/學生登入帳號」
// 用的（要打信箱、按建立）。改成「登入代碼＋手機號碼」登入之後（見
// app/api/portal/request-login/route.ts），系統會在第一次登入核對成功時自動建立
// 綁定，不再需要手動建立這個步驟——手機號碼本來就是學籍資料/監護人資料的一部分，
// 直接抓現有資料比對，不用另外維護一份。
//
// 這頁改成「查詢工具」：輸入學號，看得到這個學生／監護人目前登記的手機號碼是什麼
// （核對登入代碼要用哪一支電話），還有這兩組代碼是不是已經有人登入過，方便校務
// 人員在把代碼交給家長/學生之前，先確認資料是不是齊全、正確。
export default function PortalAccountsPage() {
  const [studentNo, setStudentNo] = useState('');
  const [result, setResult] = useState<LookupResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLookup(e: React.FormEvent) {
    e.preventDefault();
    if (!studentNo) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const { data: studentRow, error: studentErr } = await supabase
        .from('students')
        .select('student_no, name, phone')
        .eq('student_no', studentNo)
        .maybeSingle();
      if (studentErr) {
        setError('查詢失敗：' + studentErr.message);
        return;
      }
      if (!studentRow) {
        setError('查無此學號');
        return;
      }
      const { data: guardianRows } = await supabase.from('guardians').select('relation, name, phone').eq('student_no', studentNo);
      const { data: linkedRows } = await supabase
        .from('portal_accounts')
        .select('login_code, auth_user_id')
        .eq('student_no', studentNo);
      const hyRow = (linkedRows ?? []).find((r: any) => r.login_code === `HY${studentNo}`.toUpperCase());
      const hysRow = (linkedRows ?? []).find((r: any) => r.login_code === `HYS${studentNo}`.toUpperCase());

      setResult({
        studentNo: studentRow.student_no,
        studentName: studentRow.name,
        studentPhone: studentRow.phone,
        guardians: (guardianRows ?? []) as GuardianRow[],
        hyLinked: !!hyRow?.auth_user_id,
        hysLinked: !!hysRow?.auth_user_id,
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ maxWidth: 520, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>家長／學生登入查詢</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        現在不用手動建立家長／學生的登入帳號了：家長／學生自己在【家長／學生查詢入口】輸入登入代碼（家長 HY+學號、學生本人
        HYS+學號）跟登記在學籍資料裡的手機號碼，系統會自動核對、自動建立登入。這頁純粹是輸入學號查詢「目前學籍資料登記的手機號碼是什麼」，
        方便您把代碼交給家長/學生之前，先確認資料齊全、電話正確——如果手機號碼是空的或登記錯誤，麻煩先到學籍資料頁補上/更正，
        不然會登入不了。
      </p>

      <form onSubmit={handleLookup} style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <input
          placeholder="學號"
          value={studentNo}
          onChange={(e) => setStudentNo(e.target.value)}
          style={{ padding: 8, flex: 1 }}
          required
        />
        <button type="submit" disabled={loading} style={{ padding: '8px 16px', background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 6 }}>
          {loading ? '查詢中…' : '查詢'}
        </button>
      </form>

      {error && <p style={{ color: '#A32D2D', fontSize: 13, marginBottom: 16 }}>{error}</p>}

      {result && (
        <div style={{ fontSize: 13, lineHeight: 1.8 }}>
          <p style={{ marginBottom: 12 }}>
            <strong>{result.studentName}</strong>（學號 {result.studentNo}）
          </p>

          <div style={{ background: '#FAFAF8', border: '1px solid #eee', borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <p style={{ fontWeight: 600, marginBottom: 4 }}>
              學生本人代碼：HYS{result.studentNo}　{result.hysLinked && <span style={{ color: '#3B6D11' }}>（已登入過）</span>}
            </p>
            <p style={{ color: result.studentPhone ? '#2C2C2A' : '#A32D2D' }}>
              學籍資料登記的手機號碼：{result.studentPhone || '（尚未登記，需先補上才能登入）'}
            </p>
          </div>

          <div style={{ background: '#FAFAF8', border: '1px solid #eee', borderRadius: 8, padding: 12 }}>
            <p style={{ fontWeight: 600, marginBottom: 4 }}>
              家長代碼：HY{result.studentNo}　{result.hyLinked && <span style={{ color: '#3B6D11' }}>（已登入過）</span>}
            </p>
            {result.guardians.length === 0 ? (
              <p style={{ color: '#A32D2D' }}>尚未登記任何監護人資料，需先補上才能登入。</p>
            ) : (
              result.guardians.map((g, i) => (
                <p key={i} style={{ color: g.phone ? '#2C2C2A' : '#A32D2D' }}>
                  {g.relation}
                  {g.name ? `（${g.name}）` : ''}：{g.phone || '（尚未登記手機號碼）'}
                </p>
              ))
            )}
            <p style={{ fontSize: 12, color: '#999', marginTop: 4 }}>家長用任一位監護人登記的手機號碼都能登入。</p>
          </div>
        </div>
      )}
    </main>
  );
}
