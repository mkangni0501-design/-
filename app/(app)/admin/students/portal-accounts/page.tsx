'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

type GuardianOption = { relation: string; email: string | null };

export default function PortalAccountsPage() {
  const [studentNo, setStudentNo] = useState('');
  const [email, setEmail] = useState('');
  const [relation, setRelation] = useState('家長');
  const [guardianOptions, setGuardianOptions] = useState<GuardianOption[]>([]);
  const [createdCode, setCreatedCode] = useState<{ code: string; relation: string } | null>(null);

  // 學號輸入完離開欄位時，把該生監護人資料裡已經登記的信箱抓出來，點一下就能帶入，不用重打
  async function handleLookupGuardians() {
    if (!studentNo) return;
    const { data } = await supabase.from('guardians').select('relation, email').eq('student_no', studentNo);
    setGuardianOptions(((data ?? []) as GuardianOption[]).filter((g) => g.email));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    // 【2026-08-23 修正】原本不管「家長」還是「學生本人」都產生同一組代碼
    // HY+學號，login_code 在資料庫是 unique，同一個學生只要先建立過一種身分的
    // 帳號（例如家長），之後再建立另一種身分（學生本人）就會撞號、新增失敗、
    // 而且錯誤訊息（唯一鍵衝突）對承辦人來說不容易看懂到底哪裡出錯。
    // 改成依身分在代碼加識別字：家長維持原本「HY+學號」（不影響已經
    // 發出去的家長代碼），學生本人原本是「HY+學號+S」字尾。
    // 【2026-08-24 依回饋修正】學生本人代碼改成「HYS+學號」（字首而不是字尾）。
    // 同時把原本「帶入{監護人}信箱」按鈕的 bug 一併修掉：這個按鈕原本除了帶入
    // email，還會用 setRelation(g.relation) 把下面「身分」下拉選單的值，直接
    // 覆蓋成 guardians 表裡的監護人關係（父/母/監護人…），但 portal_accounts.
    // relation 這個欄位語意上只應該是「家長」或「學生本人」兩種身分別，跟
    // guardians.relation（父/母/監護人）根本是兩件事——按下這顆按鈕之後，
    // 「身分」下拉選單的畫面值會變成不在選項清單裡的字串（例如「父」），
    // 送出時就會把這個不對的值存進 portal_accounts.relation，導致：
    // 1. 代碼判斷式（下面這行）誤判成「家長」規則產生代碼（因為不等於
    //    '學生本人'），承辦人卻可能誤以為自己正在建立的是「學生本人」帳號；
    // 2. 之後任何「依 relation='學生本人' 篩選」的地方（例如社團選社頁只讓
    //    學生本人身分填志願）都會找不到這筆帳號，看起來就像「學生登入後找不到
    //    資料」。
    // 已經改成按鈕只帶入 email、不再動 relation（見下面 guardianOptions 的
    // onClick），這裡额外再加一層防呆：送出前先確認 relation 一定是這兩個
    // 合法值之一，不是的話直接擋下來、不送出，避免任何殘留狀態流進資料庫。
    if (relation !== '家長' && relation !== '學生本人') {
      alert('身分欄位異常，請重新選擇「家長」或「學生本人」後再送出。');
      return;
    }
    const loginCode = (relation === '學生本人' ? `HYS${studentNo}` : `HY${studentNo}`).toUpperCase();
    const { error } = await supabase.from('portal_accounts').insert({
      student_no: studentNo,
      email,
      relation,
      login_code: loginCode,
    });
    if (error) {
      // unique 衝突通常代表這個學生這個身分（家長或學生本人）已經建立過帳號了，
      // 給承辦人看得懂的提示，而不是直接丟資料庫原始錯誤訊息。
      if (error.code === '23505' || /duplicate|unique/i.test(error.message)) {
        alert(`建立失敗：這個學號的「${relation}」帳號已經建立過了（代碼 ${loginCode}），不能重複建立。`);
      } else {
        alert('建立失敗：' + error.message);
      }
      return;
    }
    setCreatedCode({ code: loginCode, relation });
    setStudentNo('');
    setEmail('');
    setGuardianOptions([]);
    // 注意：relation（身分下拉選單）故意不重設，維持承辦人剛剛選的身分──
    // 學校常見的操作習慣是連續替同一批學生建立「同一種身分」的帳號（例如
    // 一次把全班的「學生本人」帳號都建立完，再切換身分建家長帳號），保留
    // 選擇比每次都要重新選更順手。
  }

  return (
    <main style={{ maxWidth: 420, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>建立家長／學生登入帳號</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        登入代碼會自動產生：家長是「HY+學號」，學生本人是「HYS+學號」，同一個學生的家長跟學生本人可以各建立一組。請把代碼跟登記的信箱一起告訴家長／學生，登入時兩者都要對得上。
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
                  // 【2026-08-24 修正】這裡原本還會一併 setRelation(g.relation)，
                  // 把「身分」下拉選單的值覆蓋成監護人關係（父/母/監護人…），
                  // 但那個欄位的合法值只有「家長」/「學生本人」兩種，跟這裡的
                  // g.relation（guardians 表的父/母/監護人）語意完全不同，
                  // 誤用會把錯的 relation 存進 portal_accounts（詳見上面
                  // handleCreate 的說明）。這顆按鈕現在只負責帶入 email 這個
                  // 純粹省打字的功能，「身分」還是要由下面的下拉選單決定。
                  setEmail(g.email!);
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
          已建立，登入代碼是 <b>{createdCode.code}</b>，請連同登記的信箱一起告訴{createdCode.relation === '學生本人' ? '學生本人' : '家長'}。
        </p>
      )}
    </main>
  );
}
