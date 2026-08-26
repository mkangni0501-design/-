'use client';

import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { SPECIFIC_GRADE_LEVELS } from '@/lib/gradeMapping';
import ErrorBanner from '@/components/ErrorBanner';
import { useDepartmentPermissions } from '@/lib/useDepartmentPermissions';
import { writeGoverned } from '@/lib/pendingChanges';
import { isDepartmentLead } from '@/lib/departments';
import PendingChangesReviewPanel from '@/components/PendingChangesReviewPanel';
import MyPendingChangesList from '@/components/MyPendingChangesList';

type CurriculumRow = { id: string; academic_year: number; term: string; grade_level: string; subject: string; weight: number; periods: number | null };

const emptyForm = { academic_year: new Date().getFullYear(), term: '上學期', grade_level: '', subject: '', weight: '', periods: '' };

export default function CurriculumAdminPage() {
  const perms = useDepartmentPermissions();
  const canWriteDirect = perms.isSystemAdmin || isDepartmentLead(perms.myDepartments, 'academic');

  const [rows, setRows] = useState<CurriculumRow[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchWeight, setBatchWeight] = useState('');
  // 「各科目百分比批次修改」：原本只能勾選多筆、套用同一個比重數字。
  // 這裡改成可以直接在表格內每一列各自輸入不同的新比重，最後一次按「儲存所有修改」統一送出，
  // 不用像原本那樣被迫把選取的幾科都改成同一個數字。
  const [editedWeights, setEditedWeights] = useState<Record<string, string>>({});
  // 修正比重時可以直接按 ENTER 換下一個科目的輸入框，不用每次都用滑鼠點下一格。
  const weightInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  function focusNextWeightInput(currentId: string) {
    const idx = rows.findIndex((r) => r.id === currentId);
    for (let i = idx + 1; i < rows.length; i++) {
      const el = weightInputRefs.current[rows[i].id];
      if (el) {
        el.focus();
        el.select();
        return;
      }
    }
  }
  const [savingAll, setSavingAll] = useState(false);

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleSelectAll() {
    setSelected((prev) => (prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.id))));
  }

  const [armedAction, setArmedAction] = useState<'delete' | 'edit' | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  async function handleBatchDelete() {
    if (selected.size === 0 || !perms.userId) return;
    if (canWriteDirect) {
      const { error } = await supabase.from('curriculum').delete().in('id', Array.from(selected));
      setArmedAction(null);
      if (error) {
        alert('批次刪除失敗：' + error.message);
        return;
      }
    } else {
      // staff：逐筆送審（每一筆都要留下獨立的核准紀錄）
      for (const id of Array.from(selected)) {
        const row = rows.find((r) => r.id === id);
        await writeGoverned('curriculum', 'delete', {}, {
          myDepartments: perms.myDepartments,
          isSystemAdmin: perms.isSystemAdmin,
          requestedBy: perms.userId,
          recordKey: id,
          beforeSnapshot: row ?? null,
        });
      }
      setArmedAction(null);
      alert(`已送出 ${selected.size} 筆刪除申請，等教務主管核准後才會真正刪除。`);
    }
    setSelected(new Set());
    load();
  }

  async function handleSaveAllWeights() {
    const changed = Object.entries(editedWeights).filter(([id, val]) => {
      const row = rows.find((r) => r.id === id);
      return row && val !== '' && Number(val) !== Number(row.weight);
    });
    if (changed.length === 0 || !perms.userId) return;
    setSavingAll(true);
    if (canWriteDirect) {
      const results = await Promise.all(
        changed.map(([id, val]) => supabase.from('curriculum').update({ weight: Number(val) }).eq('id', id))
      );
      const firstError = results.find((r) => r.error)?.error;
      setSavingAll(false);
      if (firstError) {
        alert('儲存失敗：' + firstError.message);
        return;
      }
    } else {
      for (const [id, val] of changed) {
        const row = rows.find((r) => r.id === id);
        await writeGoverned('curriculum', 'update', { weight: Number(val) }, {
          myDepartments: perms.myDepartments,
          isSystemAdmin: perms.isSystemAdmin,
          requestedBy: perms.userId,
          recordKey: id,
          beforeSnapshot: row ?? null,
        });
      }
      setSavingAll(false);
      alert(`已送出 ${changed.length} 筆改比重申請，等教務主管核准後才會生效。`);
    }
    setEditedWeights({});
    load();
  }

  async function handleBatchEditWeight() {
    if (selected.size === 0 || batchWeight === '' || !perms.userId) return;
    if (canWriteDirect) {
      const { error } = await supabase.from('curriculum').update({ weight: Number(batchWeight) }).in('id', Array.from(selected));
      setArmedAction(null);
      if (error) {
        alert('批次修改失敗：' + error.message);
        return;
      }
    } else {
      for (const id of Array.from(selected)) {
        const row = rows.find((r) => r.id === id);
        await writeGoverned('curriculum', 'update', { weight: Number(batchWeight) }, {
          myDepartments: perms.myDepartments,
          isSystemAdmin: perms.isSystemAdmin,
          requestedBy: perms.userId,
          recordKey: id,
          beforeSnapshot: row ?? null,
        });
      }
      setArmedAction(null);
      alert(`已送出 ${selected.size} 筆改比重申請，等教務主管核准後才會生效。`);
    }
    setBatchWeight('');
    setSelected(new Set());
    load();
  }

  async function load() {
    const { data, error } = await supabase.from('curriculum').select('*').order('academic_year', { ascending: false }).order('grade_level');
    setLoadError(error ? '讀取科目與比重清單失敗：' + error.message : null);
    setRows((data ?? []) as CurriculumRow[]);
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
      grade_level: form.grade_level,
      subject: form.subject,
      weight: Number(form.weight),
      periods: form.periods ? Number(form.periods) : null,
    };
    const { error, pending } = await writeGoverned('curriculum', 'insert', payload, {
      myDepartments: perms.myDepartments,
      isSystemAdmin: perms.isSystemAdmin,
      requestedBy: perms.userId,
    });
    if (error) {
      alert('新增失敗：' + error);
      return;
    }
    if (pending) alert('已送出新增申請，等教務主管核准後才會生效。');
    setForm({ ...emptyForm, academic_year: form.academic_year, term: form.term, grade_level: form.grade_level });
    load();
  }

  async function handleDelete(id: string) {
    if (!perms.userId) return;
    const row = rows.find((r) => r.id === id);
    const { error, pending } = await writeGoverned('curriculum', 'delete', {}, {
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

  // 依年級把比重加總顯示，方便管理員檢查有沒有加起來不是100%（王小雲那個案例的根本預防）
  const weightSumByGrade: Record<string, number> = {};
  rows.forEach((r) => {
    const key = `${r.academic_year}-${r.term}-${r.grade_level}`;
    weightSumByGrade[key] = (weightSumByGrade[key] ?? 0) + Number(r.weight);
  });

  if (perms.loading) return null;

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>科目與比重設定</h1>
      <ErrorBanner message={loadError} />
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        每學期開學前，請為每個年級設定當學期的科目與比重。同一年級同一學期的比重加總應該等於1.0。
      </p>

      {!canWriteDirect && perms.userId && (
        <p style={{ fontSize: 12, color: '#A36A00', background: '#FFF8E1', border: '1px solid #f0d98a', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
          您的帳號是教務承辦人員，這裡的新增／修改／刪除會先送給教務主管核准，核准後才會真正生效。
        </p>
      )}

      <PendingChangesReviewPanel
        department="academic"
        reviewerId={perms.userId ?? ''}
        canReview={isDepartmentLead(perms.myDepartments, 'academic') || perms.isSystemAdmin}
        onReviewed={load}
      />

      <p style={{ fontSize: 12, color: '#A36A00', background: '#FFF8E1', border: '1px solid #f0d98a', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
        「節數」欄位已經統一改由【排課系統（自動排課工具）】排課完成後自動寫入（存檔時會自動蓋掉這裡舊的節數），這裡不再提供整批上傳節數的功能。
        「比重」請用下面的「新增」表單逐筆設定，或是勾選多筆後用「批次改比重」一次修改整個年級。
        全新學校第一次建檔（還沒用過排課系統）需要整批匯入節數＋比重時，請到【開發人員區】使用「一鍵上傳/下載」。
      </p>

      <details style={{ fontSize: 12, color: '#444', background: '#F7F5F0', border: '1px solid #E5E1D8', borderRadius: 6, padding: '8px 12px', margin: '10px 0 20px' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 'bold', color: '#2C6E9E' }}>【開發人員區】整批匯入格式說明（只有全新建檔才需要看）</summary>
        <div style={{ marginTop: 8, lineHeight: 1.7 }}>
          <p><b>每一列＝一筆「比重設定」</b>，可以同時涵蓋好幾個年級——但前提是這幾個年級要用「同一個比重、同一個節數」。如果同一科目在不同年級的比重不一樣（例如國中一年級國文佔20%、國中二年級佔18%），請拆成不同列各填一次。</p>
          <p><b>表頭第1列（H欄開始）</b>是系統認得的「具體年級」清單：幼兒園、幼甲、幼乙、1年～6年、初一～三、高一～三。這些欄位標題文字<b>請不要更改、也不要調整順序</b>（系統是照文字去比對欄位，不是照欄位位置），用不到的年級欄位留著、不用刪除。</p>
          <p>每一列（從第2列開始）各欄位意義：</p>
          <ul style={{ paddingLeft: 20, margin: '4px 0' }}>
            <li>A欄＝學年度（每一列都要填，不同列可以填不同學年度）</li>
            <li>B～E欄＝保留欄位，目前沒有作用，可以留空</li>
            <li>F欄＝比重，填0～1之間的小數（例如0.2代表20%）</li>
            <li>G欄＝節數，每週幾節課（非必填，全新建檔後排課系統存檔時會蓋掉這裡的節數）</li>
            <li>H欄開始＝找到對應年級的欄位，填入「這個年級對這個科目的稱呼」。通常直接填科目名稱即可（例如都填「國文」）；也可以不同年級填不同名稱（例如國小欄位填「國語」、國中/高中欄位填「國文」），這樣同一列就能同時設定國小＋國中＋高中——只要這幾個年級的比重、節數相同</li>
            <li>該年級沒有開這門課，把那個年級的欄位留空即可</li>
          </ul>
          <p><b>學期是上傳時彈出視窗詢問</b>（不是寫在欄位裡），代表一份檔案只能設定同一個學期。如果上、下學期的科目比重不一樣，請分兩次個別上傳，上傳時選不同學期。</p>
          <p>上傳採「同學年度＋學期＋年級＋科目」為準，重複上傳同樣的組合會直接覆蓋掉原本的比重/節數（不會變成兩筆重複資料），所以填錯了可以直接改一改再上傳一次修正，不用先手動刪除。</p>
          <p>上傳完成後，回到下面的清單，如果某個年級同學期的比重加總不是1.0（100%），該列會顯示紅色警示，記得檢查。</p>
        </div>
      </details>

      <form onSubmit={handleAdd} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 20 }}>
        <input
          type="number"
          placeholder="學年度"
          value={form.academic_year}
          onChange={(e) => setForm({ ...form, academic_year: Number(e.target.value) })}
          style={{ width: 90, padding: 6 }}
          required
        />
        <select value={form.term} onChange={(e) => setForm({ ...form, term: e.target.value })} style={{ padding: 6 }}>
          <option value="上學期">上學期</option>
          <option value="下學期">下學期</option>
        </select>
        <input
          placeholder="年級（例如 1年）"
          value={form.grade_level}
          onChange={(e) => setForm({ ...form, grade_level: e.target.value })}
          style={{ width: 110, padding: 6 }}
          required
        />
        <input
          placeholder="科目"
          value={form.subject}
          onChange={(e) => setForm({ ...form, subject: e.target.value })}
          style={{ width: 100, padding: 6 }}
          required
        />
        <input
          type="number"
          step="0.01"
          placeholder="比重(0-1)"
          value={form.weight}
          onChange={(e) => setForm({ ...form, weight: e.target.value })}
          style={{ width: 90, padding: 6 }}
          required
        />
        <input
          type="number"
          placeholder="節數"
          value={form.periods}
          onChange={(e) => setForm({ ...form, periods: e.target.value })}
          style={{ width: 70, padding: 6 }}
        />
        <button type="submit" style={{ padding: '6px 14px', background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 6 }}>
          {canWriteDirect ? '新增' : '送出新增申請'}
        </button>
      </form>

      {perms.userId && <MyPendingChangesList userId={perms.userId} tableName="curriculum" />}

      {selected.size > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12, padding: 8, background: '#F5F5F3', borderRadius: 6 }}>
          <span style={{ fontSize: 12, color: '#666' }}>已選取 {selected.size} 筆</span>
          {armedAction === null && (
            <>
              <input
                type="number"
                step="0.01"
                placeholder="批次改比重(0-1)"
                value={batchWeight}
                onChange={(e) => setBatchWeight(e.target.value)}
                style={{ width: 100, padding: 4, fontSize: 12 }}
              />
              <button onClick={() => setArmedAction('edit')} style={{ fontSize: 12, padding: '4px 10px' }}>
                批次改比重
              </button>
              <button onClick={() => setArmedAction('delete')} style={{ fontSize: 12, padding: '4px 10px', color: '#A32D2D' }}>
                批次刪除
              </button>
              <button onClick={() => setSelected(new Set())} style={{ fontSize: 12, padding: '4px 10px' }}>
                取消選取
              </button>
            </>
          )}
          {armedAction === 'edit' && (
            <>
              <span style={{ fontSize: 12 }}>確定要把這 {selected.size} 筆比重都改成 {batchWeight} 嗎？</span>
              <button onClick={handleBatchEditWeight} style={{ fontSize: 12, padding: '4px 10px', background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 4 }}>
                確定
              </button>
              <button onClick={() => setArmedAction(null)} style={{ fontSize: 12, padding: '4px 10px' }}>
                取消
              </button>
            </>
          )}
          {armedAction === 'delete' && (
            <>
              <span style={{ fontSize: 12, color: '#A32D2D' }}>確定要刪除這 {selected.size} 筆嗎？此動作無法復原。</span>
              <button onClick={handleBatchDelete} style={{ fontSize: 12, padding: '4px 10px', background: '#A32D2D', color: '#fff', border: 'none', borderRadius: 4 }}>
                確定刪除
              </button>
              <button onClick={() => setArmedAction(null)} style={{ fontSize: 12, padding: '4px 10px' }}>
                取消
              </button>
            </>
          )}
        </div>
      )}

      {Object.keys(editedWeights).length > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, padding: 8, background: '#EAF2E8', borderRadius: 6 }}>
          <span style={{ fontSize: 12, color: '#3B6D11' }}>已修改 {Object.keys(editedWeights).length} 科的比重，尚未儲存</span>
          <button
            onClick={handleSaveAllWeights}
            disabled={savingAll}
            style={{ fontSize: 12, padding: '4px 12px', background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 4 }}
          >
            {savingAll ? '儲存中…' : canWriteDirect ? '儲存所有修改' : '送出所有修改申請'}
          </button>
          <button onClick={() => setEditedWeights({})} style={{ fontSize: 12, padding: '4px 10px' }}>
            還原修改
          </button>
        </div>
      )}

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            <th style={{ padding: 6 }}>
              <input type="checkbox" checked={rows.length > 0 && selected.size === rows.length} onChange={toggleSelectAll} />
            </th>
            <th style={{ textAlign: 'left', padding: 6 }}>學年/學期</th>
            <th style={{ textAlign: 'left', padding: 6 }}>年級</th>
            <th style={{ textAlign: 'left', padding: 6 }}>科目</th>
            <th style={{ textAlign: 'right', padding: 6 }}>比重（可直接改，改完按上方「儲存所有修改」一次存檔）</th>
            <th style={{ textAlign: 'right', padding: 6 }}>節數</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const key = `${r.academic_year}-${r.term}-${r.grade_level}`;
            const sum = weightSumByGrade[key];
            const editedVal = editedWeights[r.id];
            return (
              <tr key={r.id} style={{ borderTop: '1px solid #eee' }}>
                <td style={{ padding: 6 }}>
                  <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleSelect(r.id)} />
                </td>
                <td style={{ padding: 6 }}>{r.academic_year} {r.term}</td>
                <td style={{ padding: 6 }}>{r.grade_level}</td>
                <td style={{ padding: 6 }}>{r.subject}</td>
                <td style={{ padding: 6, textAlign: 'right' }}>
                  <input
                    type="number"
                    step="0.01"
                    ref={(el) => {
                      weightInputRefs.current[r.id] = el;
                    }}
                    value={editedVal ?? r.weight}
                    onChange={(e) => setEditedWeights((prev) => ({ ...prev, [r.id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        focusNextWeightInput(r.id);
                      }
                    }}
                    style={{
                      width: 80,
                      padding: 4,
                      textAlign: 'right',
                      background: editedVal !== undefined && Number(editedVal) !== Number(r.weight) ? '#FFF8E1' : '#fff',
                      border: '1px solid #ccc',
                      borderRadius: 4,
                    }}
                  />
                  {Math.abs(sum - 1) > 0.001 && <span style={{ color: '#A32D2D', marginLeft: 4 }}>⚠ 該年級加總={sum.toFixed(2)}</span>}
                </td>
                <td style={{ padding: 6, textAlign: 'right' }}>{r.periods ?? '—'}</td>
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
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
