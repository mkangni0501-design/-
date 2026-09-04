'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { resolveCurrentTerm } from '@/lib/academicTerm';

type ClubOption = { id: string; name: string; capacity: number | null; description: string | null };
type SelectionWindow = {
  academic_year: number;
  term: string;
  method: '志願序_第一志願優先' | '志願序_隨機亂數' | '即時搶選';
  max_choices: number | null;
  opens_at: string;
  closes_at: string | null;
  is_finalized: boolean;
};

// 學生選社頁：依教務處在「社團管理」設定的方式，顯示志願序填寫表單，或即時搶選按鈕。
// 只有「學生本人」身分登入才看得到這頁的功能，家長帳號不能代替學生選社。
export default function StudentClubSelectionPage() {
  const router = useRouter();
  const [studentNo, setStudentNo] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [win, setWin] = useState<SelectionWindow | null>(null);
  const [clubs, setClubs] = useState<ClubOption[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [myMembership, setMyMembership] = useState<string | null>(null);
  const [choices, setChoices] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function loadAll() {
    setLoading(true);
    setError(null);
    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData.session) {
      router.push('/portal/login');
      return;
    }

    const { data: selfAccount } = await supabase
      .from('portal_accounts')
      .select('student_no')
      .eq('auth_user_id', sessionData.session.user.id)
      .eq('relation', '學生本人')
      .maybeSingle();
    if (!selfAccount) {
      setStudentNo(null);
      setLoading(false);
      return;
    }
    setStudentNo(selfAccount.student_no);

    const term = await resolveCurrentTerm();
    if (!term) {
      setError('學校尚未設定目前學年學期');
      setLoading(false);
      return;
    }

    const { data: windowRow } = await supabase
      .from('club_selection_windows')
      .select('academic_year, term, method, max_choices, opens_at, closes_at, is_finalized')
      .eq('academic_year', term.academic_year)
      .eq('term', term.term)
      .maybeSingle();
    setWin((windowRow as SelectionWindow) ?? null);

    const { data: clubRows } = await supabase
      .from('clubs')
      .select('id, name, capacity, description')
      .eq('academic_year', term.academic_year)
      .eq('term', term.term)
      .eq('is_active', true)
      .order('name');
    setClubs((clubRows ?? []) as ClubOption[]);

    const { data: countRows } = await supabase.rpc('club_member_counts', { p_academic_year: term.academic_year, p_term: term.term });
    const countMap: Record<string, number> = {};
    (countRows ?? []).forEach((r: any) => (countMap[r.club_id] = Number(r.current_count)));
    setCounts(countMap);

    const { data: myMemberRows } = await supabase
      .from('club_members')
      .select('club_id, status')
      .eq('student_no', selfAccount.student_no)
      .eq('status', '在社');
    const myClubId = (myMemberRows ?? [])[0]?.club_id ?? null;
    setMyMembership(myClubId);

    if (windowRow?.method?.startsWith('志願序_')) {
      const { data: prefRows } = await supabase
        .from('club_preferences')
        .select('club_id, choice_rank')
        .eq('academic_year', term.academic_year)
        .eq('term', term.term)
        .eq('student_no', selfAccount.student_no)
        .order('choice_rank');
      const maxChoices = windowRow.max_choices ?? 5;
      const arr = new Array(maxChoices).fill('');
      (prefRows ?? []).forEach((p: any) => {
        if (p.choice_rank >= 1 && p.choice_rank <= maxChoices) arr[p.choice_rank - 1] = p.club_id;
      });
      setChoices(arr);
    }

    setLoading(false);
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function isOpen(): boolean {
    if (!win) return false;
    const now = new Date();
    if (now < new Date(win.opens_at)) return false;
    if (win.closes_at && now > new Date(win.closes_at)) return false;
    return true;
  }

  async function submitPreferences() {
    if (!win) return;
    setSaving(true);
    setMsg(null);
    const picked = choices.filter((c) => c !== '');
    if (new Set(picked).size !== picked.length) {
      setMsg('志願清單裡有重複選到同一個社團，請確認每個志願都選不同社團');
      setSaving(false);
      return;
    }
    if (picked.length === 0) {
      setMsg('請至少選一個志願');
      setSaving(false);
      return;
    }
    // 先刪掉自己這學期原本填過的志願，再整批重新寫入（比逐筆比對簡單，人數不多不會有效能問題）
    const { error: delErr } = await supabase
      .from('club_preferences')
      .delete()
      .eq('academic_year', win.academic_year)
      .eq('term', win.term)
      .eq('student_no', studentNo as string);
    if (delErr) {
      setMsg('儲存失敗：' + delErr.message);
      setSaving(false);
      return;
    }
    const rows = choices.map((clubId, idx) => (clubId ? { academic_year: win.academic_year, term: win.term, student_no: studentNo, club_id: clubId, choice_rank: idx + 1 } : null)).filter(Boolean);
    if (rows.length > 0) {
      const { error: insErr } = await supabase.from('club_preferences').insert(rows as any[]);
      if (insErr) {
        setMsg('儲存失敗：' + insErr.message);
        setSaving(false);
        return;
      }
    }
    setMsg('志願序已送出，可以在截止前再回來修改');
    setSaving(false);
  }

  async function joinFirstCome(clubId: string) {
    setSaving(true);
    setMsg(null);
    const { data, error: rpcErr } = await supabase.rpc('join_club_first_come', { p_club_id: clubId });
    if (rpcErr) {
      setMsg('報名失敗：' + rpcErr.message);
    } else {
      setMsg(data as string);
      loadAll();
    }
    setSaving(false);
  }

  if (loading) return <main style={{ padding: 24 }}>載入中…</main>;

  if (!studentNo) {
    return (
      <main style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
        <h1 style={{ fontSize: 16 }}>社團／才藝課選社</h1>
        <p style={{ fontSize: 13, color: '#999' }}>這個功能只開放給「學生本人」帳號使用，請用學生本人的登入代碼登入後再回來這裡。</p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>社團／才藝課選社</h1>
      {error && <p style={{ fontSize: 13, color: '#A32D2D' }}>{error}</p>}

      {myMembership && (
        <p style={{ fontSize: 13, color: '#2D7A3A', marginBottom: 16 }}>
          您目前已經分發到「{clubs.find((c) => c.id === myMembership)?.name ?? '（社團資料查詢中）'}」，如需異動請洽教務處。
        </p>
      )}

      {!win && <p style={{ fontSize: 13, color: '#999' }}>教務處尚未開放這學期的選社作業，請稍後再回來查看。</p>}

      {win && !myMembership && (
        <>
          <p style={{ fontSize: 12, color: '#666', marginBottom: 12 }}>
            這學期選社方式：{win.method === '即時搶選' ? '即時搶選（先搶先贏）' : win.method === '志願序_第一志願優先' ? '志願序抽籤（第一志願優先法）' : '志願序抽籤（隨機亂數法）'}
            {win.opens_at && `，開放時間 ${new Date(win.opens_at).toLocaleString('zh-TW')}`}
            {win.closes_at && ` ～ ${new Date(win.closes_at).toLocaleString('zh-TW')}`}
          </p>

          {!isOpen() && !win.is_finalized && <p style={{ fontSize: 13, color: '#999', marginBottom: 16 }}>目前不在開放時間內。</p>}
          {win.is_finalized && win.method !== '即時搶選' && <p style={{ fontSize: 13, color: '#999', marginBottom: 16 }}>電腦抽籤已經執行完畢，如果上面沒有顯示您分發到的社團，請洽教務處確認。</p>}

          {msg && <p style={{ fontSize: 13, color: msg.includes('失敗') ? '#A32D2D' : '#2D7A3A', marginBottom: 12 }}>{msg}</p>}

          {win.method.startsWith('志願序_') && isOpen() && !win.is_finalized && (
            <div style={{ marginBottom: 16 }}>
              <p style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>請依喜好程度依序選填志願（志願一最優先），可以不用填滿：</p>
              {choices.map((val, idx) => (
                <div key={idx} style={{ marginBottom: 8 }}>
                  <label style={{ fontSize: 12 }}>
                    志願 {idx + 1}
                    <select
                      value={val}
                      onChange={(e) => {
                        const next = [...choices];
                        next[idx] = e.target.value;
                        setChoices(next);
                      }}
                      style={{ display: 'block', padding: 6, marginTop: 4, width: '100%', maxWidth: 320 }}
                    >
                      <option value="">（不填）</option>
                      {clubs.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                          {c.capacity != null ? `（名額 ${c.capacity}）` : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              ))}
              <button onClick={submitPreferences} disabled={saving} style={{ padding: '8px 20px', marginTop: 8 }}>
                {saving ? '送出中…' : '送出志願序'}
              </button>
            </div>
          )}

          {win.method === '即時搶選' && isOpen() && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {clubs.map((c) => {
                const full = c.capacity != null && (counts[c.id] ?? 0) >= c.capacity;
                return (
                  <div key={c.id} style={{ border: '1px solid #eee', borderRadius: 8, padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{c.name}</div>
                      <div style={{ fontSize: 12, color: '#999' }}>
                        {c.capacity != null ? `已報名 ${counts[c.id] ?? 0} / ${c.capacity}` : `已報名 ${counts[c.id] ?? 0} 人（不限名額）`}
                      </div>
                    </div>
                    <button onClick={() => joinFirstCome(c.id)} disabled={saving || full} style={{ padding: '6px 16px' }}>
                      {full ? '已額滿' : '報名'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </main>
  );
}
