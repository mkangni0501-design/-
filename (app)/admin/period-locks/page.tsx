'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useDepartmentPermissions } from '@/lib/useDepartmentPermissions';
import { writeGoverned } from '@/lib/pendingChanges';
import { isDepartmentLead } from '@/lib/departments';
import PendingChangesReviewPanel from '@/components/PendingChangesReviewPanel';
import MyPendingChangesList from '@/components/MyPendingChangesList';

type LockedPeriod = {
  id: string;
  academic_year: number;
  term: string;
  scope: '全校' | '部別' | '班級';
  scope_ref: string | null;
  weekday: number;
  period_no: number;
  subject: string;
  note: string | null;
};

const WEEKDAY_LABEL = ['', '一', '二', '三', '四', '五', '六'];

const emptyForm = {
  academic_year: new Date().getFullYear(),
  term: '上學期' as '上學期' | '下學期',
  scope: '全校' as '全校' | '部別' | '班級',
  scope_ref: '',
  weekday: 1,
  period_no: 1,
  subject: '',
  note: '',
};

// 共同科目時間鎖定：設定某個範圍某星期某節，鎖定給共同科目使用（升旗/朝會/班會等），
// 這個時段【自動排課工具】不會排入一般課程。本頁只負責「登記鎖定」，共同科目本身怎麼上課不由本系統安排。
export default function PeriodLocksPage() {
  const perms = useDepartmentPermissions();
  const canWriteDirect = perms.isSystemAdmin || isDepartmentLead(perms.myDepartments, 'academic');

  const [rows, setRows] = useState<LockedPeriod[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  async function load() {
    const { data, error } = await supabase
      .from('locked_periods')
      .select('*')
      .order('academic_year', { ascending: false })
      .order('weekday')
      .order('period_no');
    setLoadError(error ? '讀取鎖定時段清單失敗：' + error.message : null);
    setRows((data ?? []) as LockedPeriod[]);
  }

  useEffect(() => {
    load();
  }, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!perms.userId) return;
    const payload = {
      academic_year: Number(form.academic_year),
      term: form.term,
      scope: form.scope,
      scope_ref: form.scope === '全校' ? null : form.scope_ref || null,
      weekday: Number(form.weekday),
      period_no: Number(form.period_no),
      subject: form.subject,
      note: form.note || null,
      created_by: perms.userId,
    };
    const { error, pending } = await writeGoverned('locked_periods', 'insert', payload, {
      myDepartments: perms.myDepartments,
      isSystemAdmin: perms.isSystemAdmin,
      requestedBy: perms.userId,
    });
    if (error) {
      alert('新增失敗：' + error);
      return;
    }
    if (pending) alert('已送出新增申請，等教務主管核准後才會生效。');
    setForm({ ...emptyForm, academic_year: form.academic_year, term: form.term });
    load();
  }

  async function handleDelete(id: string) {
    if (!perms.userId) return;
    const row = rows.find((r) => r.id === id);
    const { error, pending } = await writeGoverned('locked_periods', 'delete', {}, {
      myDepartments: perms.myDepartments,
      isSystemAdmin: perms.isSystemAdmin,
      requestedBy: perms.userId,
      recordKey: id,
      beforeSnapshot: row ?? null,
    });
    setConfirmDeleteId(null);
    if (error) {
      alert('刪除失敗：' + error);
      return;
    }
    if (pending) alert('已送出刪除申請，等教務主管核准後才會真正刪除。');
    load();
  }

  if (perms.loading) return null;

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>共同科目時間鎖定</h1>
      {loadError && <p style={{ color: '#A32D2D', fontSize: 12 }}>{loadError}</p>}
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        設定某個範圍（全校／部別／班級）某星期某節，鎖定給共同科目使用（例如：升旗、朝會、班會、聯課活動）。
        鎖定後，這個時段會顯示在【排課系統】工具內，提醒排課時不要把一般課程排進去；本頁只負責登記鎖定，
        共同科目本身怎麼安排、由誰帶班不由本系統處理。
      </p>

      <p style={{ fontSize: 12, color: '#A36A00', background: '#FFF8E1', border: '1px solid #f0d98a', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
        ⚠ 目前【自動排課工具】只會「顯示」這裡登記的鎖定時段供人工參考，還沒有做到自動把這些時段從排課演算法裡整個排除
        （排課工具的演算法本身複雜，需要在能實際測試的環境調整以免弄壞現有排課邏輯，這件事列在下一步待辦）。
        現階段請在人工檢查課表時，對照這裡的清單確認鎖定時段沒有被排入一般課程。
      </p>

      {!canWriteDirect && perms.userId && (
        <p style={{ fontSize: 12, color: '#A36A00', background: '#FFF8E1', border: '1px solid #f0d98a', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
          您的帳號是教務承辦人員，這裡的新增／刪除會先送給教務主管核准。
        </p>
      )}
      <PendingChangesReviewPanel
        department="academic"
        reviewerId={perms.userId ?? ''}
        canReview={isDepartmentLead(perms.myDepartments, 'academic') || perms.isSystemAdmin}
        onReviewed={load}
      />

      <form onSubmit={handleAdd} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 20 }}>
        <input
          type="number"
          placeholder="學年度"
          value={form.academic_year}
          onChange={(e) => setForm({ ...form, academic_year: Number(e.target.value) })}
          style={{ width: 90, padding: 6 }}
          required
        />
        <select value={form.term} onChange={(e) => setForm({ ...form, term: e.target.value as any })} style={{ padding: 6 }}>
          <option value="上學期">上學期</option>
          <option value="下學期">下學期</option>
        </select>
        <select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value as any })} style={{ padding: 6 }}>
          <option value="全校">全校</option>
          <option value="部別">部別</option>
          <option value="班級">班級</option>
        </select>
        {form.scope !== '全校' && (
          <input
            placeholder={form.scope === '部別' ? '部別名稱' : '班級ID'}
            value={form.scope_ref}
            onChange={(e) => setForm({ ...form, scope_ref: e.target.value })}
            style={{ width: 110, padding: 6 }}
            required
          />
        )}
        <select value={form.weekday} onChange={(e) => setForm({ ...form, weekday: Number(e.target.value) })} style={{ padding: 6 }}>
          {[1, 2, 3, 4, 5, 6].map((d) => (
            <option key={d} value={d}>
              星期{WEEKDAY_LABEL[d]}
            </option>
          ))}
        </select>
        <input
          type="number"
          min={1}
          placeholder="第幾節"
          value={form.period_no}
          onChange={(e) => setForm({ ...form, period_no: Number(e.target.value) })}
          style={{ width: 80, padding: 6 }}
          required
        />
        <input
          placeholder="共同科目名稱（例如：朝會）"
          value={form.subject}
          onChange={(e) => setForm({ ...form, subject: e.target.value })}
          style={{ width: 150, padding: 6 }}
          required
        />
        <input
          placeholder="備註（選填）"
          value={form.note}
          onChange={(e) => setForm({ ...form, note: e.target.value })}
          style={{ width: 120, padding: 6 }}
        />
        <button type="submit" style={{ padding: '6px 14px', background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 6 }}>
          {canWriteDirect ? '新增鎖定' : '送出新增申請'}
        </button>
      </form>

      {perms.userId && <MyPendingChangesList userId={perms.userId} tableName="locked_periods" />}

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: 6 }}>學年/學期</th>
            <th style={{ textAlign: 'left', padding: 6 }}>範圍</th>
            <th style={{ textAlign: 'left', padding: 6 }}>時間</th>
            <th style={{ textAlign: 'left', padding: 6 }}>科目</th>
            <th style={{ textAlign: 'left', padding: 6 }}>備註</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} style={{ borderTop: '1px solid #eee' }}>
              <td style={{ padding: 6 }}>{r.academic_year} {r.term}</td>
              <td style={{ padding: 6 }}>{r.scope}{r.scope_ref ? `（${r.scope_ref}）` : ''}</td>
              <td style={{ padding: 6 }}>星期{WEEKDAY_LABEL[r.weekday]} 第{r.period_no}節</td>
              <td style={{ padding: 6 }}>{r.subject}</td>
              <td style={{ padding: 6 }}>{r.note ?? '—'}</td>
              <td style={{ padding: 6, textAlign: 'right' }}>
                {confirmDeleteId === r.id ? (
                  <span style={{ display: 'inline-flex', gap: 4 }}>
                    <button onClick={() => handleDelete(r.id)} style={{ fontSize: 12, color: '#A32D2D' }}>
                      確定刪除
                    </button>
                    <button onClick={() => setConfirmDeleteId(null)} style={{ fontSize: 12 }}>
                      取消
                    </button>
                  </span>
                ) : (
                  <button onClick={() => setConfirmDeleteId(r.id)} style={{ fontSize: 12 }}>
                    刪除
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
