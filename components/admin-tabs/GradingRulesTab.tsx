'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import ExcelUploadButton from '@/components/ExcelUploadButton';
import TemplateDownloadButton from '@/components/TemplateDownloadButton';
import { downloadGradingRulesTemplate } from '@/lib/excelTemplates';
import { uploadGradingRulesSheet } from '@/lib/bulkHandlers';
import ErrorBanner from '@/components/ErrorBanner';
import { useDepartmentPermissions } from '@/lib/useDepartmentPermissions';
import { writeGoverned } from '@/lib/pendingChanges';
import { isDepartmentLead } from '@/lib/departments';
import PendingChangesReviewPanel from '@/components/PendingChangesReviewPanel';
import MyPendingChangesList from '@/components/MyPendingChangesList';

type GradingRule = { academic_year: number; term: string; midterm_weight: number; final_weight: number; daily_weight: number };
type Adjustment = { id: string; academic_year: number; term: string; name: string; points: number; is_active: boolean };
type ConductDefault = { item: string; points: number };

export default function GradingRulesAdminPage() {
  const perms = useDepartmentPermissions();
  const canWriteDirect = perms.isSystemAdmin || isDepartmentLead(perms.myDepartments, 'academic');
  // 出缺勤/獎懲加扣分規則（conduct_point_defaults）的寫入權限跟上面「期中/期末/平時
  // 整體佔比」不是同一組——資料庫政策（sql/22department_policy_rewrite_complete.sql）
  // 是系統管理員或「訓導部門主管」才能寫，不是教務部門主管，這裡分開判斷，避免只教務
  // 主管誤以為自己能存卻被資料庫悄悄擋下（RLS 更新 0 筆不會報錯）。
  const canWriteConductDefaults = perms.isSystemAdmin || isDepartmentLead(perms.myDepartments, 'discipline');

  const [rules, setRules] = useState<GradingRule[]>([]);
  const [ruleForm, setRuleForm] = useState({ academic_year: new Date().getFullYear(), term: '上學期', midterm_weight: 0.35, final_weight: 0.35, daily_weight: 0.3 });

  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [adjForm, setAdjForm] = useState({ academic_year: new Date().getFullYear(), term: '上學期', name: '', points: '' });
  const [conductDefaults, setConductDefaults] = useState<ConductDefault[]>([]);
  // 出缺勤/獎懲預設加扣分參考值：改成可以直接編輯（見下方 handleSaveConductDefault），
  // editedConductPoints 存「使用者正在編輯、還沒存檔」的暫存值，用 item 當 key。
  const [editedConductPoints, setEditedConductPoints] = useState<Record<string, string>>({});
  const [savingConductItem, setSavingConductItem] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedAdj, setSelectedAdj] = useState<Set<string>>(new Set());
  // 目前生效中的「全勤／出缺席」科目比重（＝出缺席%），依年級各自可能不同，
  // 這裡只是唯讀顯示、方便對照，真正的編輯入口仍在「科目與比重設定」頁
  // （因為比重是依年級各自設定，這裡沒有年級篩選器，不適合直接編輯）。
  const [attendanceWeights, setAttendanceWeights] = useState<{ academic_year: number; term: string; grade_level: string; subject: string; weight: number }[]>([]);

  function toggleSelectAdj(id: string) {
    setSelectedAdj((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleSelectAllAdj() {
    setSelectedAdj((prev) => (prev.size === adjustments.length ? new Set() : new Set(adjustments.map((a) => a.id))));
  }

  const [armedDeleteAdj, setArmedDeleteAdj] = useState(false);

  async function handleBatchDeleteAdj() {
    if (selectedAdj.size === 0) return;
    const { error } = await supabase.from('score_adjustments').delete().in('id', Array.from(selectedAdj));
    setArmedDeleteAdj(false);
    if (error) {
      alert('批次刪除失敗：' + error.message);
      return;
    }
    setSelectedAdj(new Set());
    load();
  }

  async function handleBatchToggleAdj(active: boolean) {
    if (selectedAdj.size === 0) return;
    const { error } = await supabase.from('score_adjustments').update({ is_active: active }).in('id', Array.from(selectedAdj));
    if (error) {
      alert('批次修改失敗：' + error.message);
      return;
    }
    setSelectedAdj(new Set());
    load();
  }

  async function load() {
    const { data: r, error: rErr } = await supabase.from('grading_rules').select('*').order('academic_year', { ascending: false });
    setRules((r ?? []) as GradingRule[]);
    const { data: a, error: aErr } = await supabase.from('score_adjustments').select('*').order('academic_year', { ascending: false });
    setAdjustments((a ?? []) as Adjustment[]);
    const { data: c, error: cErr } = await supabase.from('conduct_point_defaults').select('*').order('item');
    setConductDefaults((c ?? []) as ConductDefault[]);
    setEditedConductPoints({});
    const { data: cw, error: cwErr } = await supabase
      .from('curriculum')
      .select('academic_year, term, grade_level, subject, weight')
      .in('subject', ['全勤', '出缺席'])
      .order('academic_year', { ascending: false })
      .order('grade_level');
    setAttendanceWeights((cw ?? []) as any[]);
    const firstError = rErr ?? aErr ?? cErr ?? cwErr;
    setLoadError(firstError ? '讀取整體佔比與加扣分規則失敗：' + firstError.message : null);
  }

  // 出缺勤/獎懲預設加扣分參考值：儲存單一項目的分數（例如「曠課」改成 -0.15）。
  // 這張表從建立以來（sql/7conduct_defaults.sql）就沒有任何畫面可以編輯，只能直接
  // 改資料庫；sql/46wire_attendance_and_discipline_adjustments.sql 已經把這張表接上
  // 「總分自動加扣分」，所以這裡改成真的可以存檔，不然管理者永遠找不到地方調整。
  async function handleSaveConductDefault(item: string) {
    const raw = editedConductPoints[item];
    if (raw === undefined) return;
    const points = Number(raw);
    if (Number.isNaN(points)) {
      alert('請輸入數字（扣分請輸入負數，例如曠課可能是 -3.33，代表換算成3%比重後影響總分-0.1）');
      return;
    }
    setSavingConductItem(item);
    const { error } = await supabase.from('conduct_point_defaults').update({ points }).eq('item', item);
    setSavingConductItem(null);
    if (error) {
      alert('儲存失敗：' + error.message);
      return;
    }
    load();
  }

  useEffect(() => {
    load();
  }, []);

  // 解析「整體佔比與加扣分規則」格式：
  // A2:C3 = 期中考/期末考/平時 三個整體佔比；E欄「項目/分數」= 曠課/遲到/...等預設參考值
  async function handleUploadFile(file: File) {
    const buf = await file.arrayBuffer();
    const XLSX = await import('xlsx');
    const wb = XLSX.read(buf, { type: 'array' });
    const sheetName = wb.SheetNames.includes('整體佔比與加扣分規則') ? '整體佔比與加扣分規則' : wb.SheetNames[0];
    const sheet = wb.Sheets[sheetName];
    const rowsRaw: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

    const yearInput = prompt('這份設定適用哪個學年度？（例如 2026）');
    const academicYear = Number(yearInput);
    const termInput = prompt('這份設定適用哪個學期？請輸入「上學期」或「下學期」', '上學期');
    if (!academicYear || (termInput !== '上學期' && termInput !== '下學期')) {
      return { successCount: 0, errors: ['學年度或學期未正確輸入，已取消'] };
    }

    const result = await uploadGradingRulesSheet(rowsRaw, academicYear, termInput);
    load();
    return result;
  }


  async function handleSaveRule(e: React.FormEvent) {
    e.preventDefault();
    if (!perms.userId) return;
    const sum = ruleForm.midterm_weight + ruleForm.final_weight + ruleForm.daily_weight;
    if (Math.abs(sum - 1) > 0.001) {
      alert(`期中+期末+平時的比重加總必須是1.0，目前是${sum.toFixed(2)}`);
      return;
    }
    const payload = {
      academic_year: Number(ruleForm.academic_year),
      term: ruleForm.term,
      midterm_weight: ruleForm.midterm_weight,
      final_weight: ruleForm.final_weight,
      daily_weight: ruleForm.daily_weight,
    };
    if (canWriteDirect) {
      const { error } = await supabase.from('grading_rules').upsert(payload, { onConflict: 'academic_year,term' });
      if (error) alert('儲存失敗：' + error.message);
      else load();
      return;
    }
    // staff：送審。先判斷是新增還是修改既有的學年/學期設定
    const existing = rules.find((r) => r.academic_year === payload.academic_year && r.term === payload.term);
    const { error, pending } = await writeGoverned(
      'grading_rules',
      existing ? 'update' : 'insert',
      payload,
      {
        myDepartments: perms.myDepartments,
        isSystemAdmin: perms.isSystemAdmin,
        requestedBy: perms.userId,
        recordKey: existing ? `${payload.academic_year}|${payload.term}` : undefined,
        beforeSnapshot: existing ?? null,
      }
    );
    if (error) {
      alert('送出申請失敗：' + error);
      return;
    }
    if (pending) alert('已送出申請，等教務主管核准後才會生效。');
    load();
  }

  async function handleAddAdjustment(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await supabase.from('score_adjustments').insert({
      academic_year: Number(adjForm.academic_year),
      term: adjForm.term,
      name: adjForm.name,
      points: Number(adjForm.points),
      is_active: false,
    });
    if (error) {
      alert('新增失敗：' + error.message);
      return;
    }
    setAdjForm({ ...adjForm, name: '', points: '' });
    load();
  }

  async function toggleAdjustment(id: string, current: boolean) {
    await supabase.from('score_adjustments').update({ is_active: !current }).eq('id', id);
    load();
  }

  if (perms.loading) return null;

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 16 }}>整體佔比與加扣分規則</h1>
      <ErrorBanner message={loadError} />

      {!canWriteDirect && perms.userId && (
        <p style={{ fontSize: 12, color: '#A36A00', background: '#FFF8E1', border: '1px solid #f0d98a', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
          您的帳號是教務承辦人員，「期中/期末/平時整體佔比」的修改會先送給教務主管核准。加扣分規則、批次上傳不受影響。
        </p>
      )}
      <PendingChangesReviewPanel
        department="academic"
        reviewerId={perms.userId ?? ''}
        canReview={isDepartmentLead(perms.myDepartments, 'academic') || perms.isSystemAdmin}
        onReviewed={load}
      />

      <h2 style={{ fontSize: 13, color: '#666', marginBottom: 4 }}>批次上傳（格式同「整體佔比與加扣分規則」工作表）</h2>
      <TemplateDownloadButton label="下載整體佔比與加扣分規則範本" onClick={downloadGradingRulesTemplate} />
      <ExcelUploadButton onFile={handleUploadFile} />

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 14, marginBottom: 8 }}>期中／期末／平時整體佔比</h2>
        <form onSubmit={handleSaveRule} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          <input
            type="number"
            placeholder="學年度"
            value={ruleForm.academic_year}
            onChange={(e) => setRuleForm({ ...ruleForm, academic_year: Number(e.target.value) })}
            style={{ width: 90, padding: 6 }}
          />
          <select value={ruleForm.term} onChange={(e) => setRuleForm({ ...ruleForm, term: e.target.value })} style={{ padding: 6 }}>
            <option value="上學期">上學期</option>
            <option value="下學期">下學期</option>
          </select>
          <input
            type="number"
            step="0.01"
            value={ruleForm.midterm_weight}
            onChange={(e) => setRuleForm({ ...ruleForm, midterm_weight: Number(e.target.value) })}
            style={{ width: 80, padding: 6 }}
            title="期中比重"
          />
          <input
            type="number"
            step="0.01"
            value={ruleForm.final_weight}
            onChange={(e) => setRuleForm({ ...ruleForm, final_weight: Number(e.target.value) })}
            style={{ width: 80, padding: 6 }}
            title="期末比重"
          />
          <input
            type="number"
            step="0.01"
            value={ruleForm.daily_weight}
            onChange={(e) => setRuleForm({ ...ruleForm, daily_weight: Number(e.target.value) })}
            style={{ width: 80, padding: 6 }}
            title="平時比重"
          />
          <button type="submit" style={{ padding: '6px 14px', background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 6 }}>
            {canWriteDirect ? '儲存' : '送出申請'}
          </button>
        </form>
        {perms.userId && <MyPendingChangesList userId={perms.userId} tableName="grading_rules" />}
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: 6 }}>學年/學期</th>
              <th style={{ textAlign: 'right', padding: 6 }}>期中</th>
              <th style={{ textAlign: 'right', padding: 6 }}>期末</th>
              <th style={{ textAlign: 'right', padding: 6 }}>平時</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={`${r.academic_year}-${r.term}`} style={{ borderTop: '1px solid #eee' }}>
                <td style={{ padding: 6 }}>{r.academic_year} {r.term}</td>
                <td style={{ padding: 6, textAlign: 'right' }}>{r.midterm_weight}</td>
                <td style={{ padding: 6, textAlign: 'right' }}>{r.final_weight}</td>
                <td style={{ padding: 6, textAlign: 'right' }}>{r.daily_weight}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2 style={{ fontSize: 14, marginBottom: 8 }}>加扣分規則（例如「全勤加分」，目前預設全部停用）</h2>
        <form onSubmit={handleAddAdjustment} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          <input
            type="number"
            placeholder="學年度"
            value={adjForm.academic_year}
            onChange={(e) => setAdjForm({ ...adjForm, academic_year: Number(e.target.value) })}
            style={{ width: 90, padding: 6 }}
          />
          <select value={adjForm.term} onChange={(e) => setAdjForm({ ...adjForm, term: e.target.value })} style={{ padding: 6 }}>
            <option value="上學期">上學期</option>
            <option value="下學期">下學期</option>
          </select>
          <input
            placeholder="規則名稱（例如 全勤加分）"
            value={adjForm.name}
            onChange={(e) => setAdjForm({ ...adjForm, name: e.target.value })}
            style={{ width: 160, padding: 6 }}
            required
          />
          <input
            type="number"
            placeholder="加扣分（負數表示扣分）"
            value={adjForm.points}
            onChange={(e) => setAdjForm({ ...adjForm, points: e.target.value })}
            style={{ width: 140, padding: 6 }}
            required
          />
          <button type="submit" style={{ padding: '6px 14px', background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 6 }}>
            新增規則
          </button>
        </form>
        {selectedAdj.size > 0 && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12, padding: 8, background: '#F5F5F3', borderRadius: 6 }}>
            <span style={{ fontSize: 12, color: '#666' }}>已選取 {selectedAdj.size} 筆</span>
            {!armedDeleteAdj ? (
              <>
                <button onClick={() => handleBatchToggleAdj(true)} style={{ fontSize: 12, padding: '4px 10px' }}>
                  批次啟用
                </button>
                <button onClick={() => handleBatchToggleAdj(false)} style={{ fontSize: 12, padding: '4px 10px' }}>
                  批次停用
                </button>
                <button onClick={() => setArmedDeleteAdj(true)} style={{ fontSize: 12, padding: '4px 10px', color: '#A32D2D' }}>
                  批次刪除
                </button>
                <button onClick={() => setSelectedAdj(new Set())} style={{ fontSize: 12, padding: '4px 10px' }}>
                  取消選取
                </button>
              </>
            ) : (
              <>
                <span style={{ fontSize: 12, color: '#A32D2D' }}>確定要刪除這 {selectedAdj.size} 筆嗎？此動作無法復原。</span>
                <button onClick={handleBatchDeleteAdj} style={{ fontSize: 12, padding: '4px 10px', background: '#A32D2D', color: '#fff', border: 'none', borderRadius: 4 }}>
                  確定刪除
                </button>
                <button onClick={() => setArmedDeleteAdj(false)} style={{ fontSize: 12, padding: '4px 10px' }}>
                  取消
                </button>
              </>
            )}
          </div>
        )}
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ padding: 6 }}>
                <input type="checkbox" checked={adjustments.length > 0 && selectedAdj.size === adjustments.length} onChange={toggleSelectAllAdj} />
              </th>
              <th style={{ textAlign: 'left', padding: 6 }}>學年/學期</th>
              <th style={{ textAlign: 'left', padding: 6 }}>名稱</th>
              <th style={{ textAlign: 'right', padding: 6 }}>分數</th>
              <th style={{ textAlign: 'center', padding: 6 }}>啟用</th>
            </tr>
          </thead>
          <tbody>
            {adjustments.map((a) => (
              <tr key={a.id} style={{ borderTop: '1px solid #eee' }}>
                <td style={{ padding: 6 }}>
                  <input type="checkbox" checked={selectedAdj.has(a.id)} onChange={() => toggleSelectAdj(a.id)} />
                </td>
                <td style={{ padding: 6 }}>{a.academic_year} {a.term}</td>
                <td style={{ padding: 6 }}>{a.name}</td>
                <td style={{ padding: 6, textAlign: 'right' }}>{a.points}</td>
                <td style={{ padding: 6, textAlign: 'center' }}>
                  <input type="checkbox" checked={a.is_active} onChange={() => toggleAdjustment(a.id, a.is_active)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 14, marginBottom: 8 }}>出缺勤/獎懲加扣分規則（曠課、遲到、事假…等每一項的扣分／加分點數）</h2>
        <p style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
          這裡的數字會自動套用到總成績：學生只要有曠課／遲到／事假／病假等紀錄，「出缺席」分數＝
          100 加上下面對應項目的點數（負數＝倒扣）加總；獎懲事件（嘉獎/小功/大功/警告/小過/大過）的
          點數則加減到操行成績。改這裡的數字，之後新產生的成績單/總分排名會立刻套用新的點數；
          已經發生的舊出缺勤/獎懲紀錄，各自記錄「當時」的點數，不會被追溯修改。
        </p>
        {!canWriteConductDefaults && (
          <p style={{ fontSize: 12, color: '#A36A00', background: '#FFF8E1', border: '1px solid #f0d98a', borderRadius: 8, padding: '8px 12px', marginBottom: 8 }}>
            這組數字只有系統管理員或訓導部門主管能修改，您目前的帳號沒有寫入權限（下面的輸入框會唯讀）。
          </p>
        )}
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: 6 }}>項目</th>
              <th style={{ textAlign: 'right', padding: 6 }}>分數（負數＝扣分）</th>
              <th style={{ padding: 6 }}></th>
            </tr>
          </thead>
          <tbody>
            {conductDefaults.map((c) => {
              const edited = editedConductPoints[c.item] ?? String(c.points);
              const dirty = editedConductPoints[c.item] !== undefined && Number(editedConductPoints[c.item]) !== c.points;
              return (
                <tr key={c.item} style={{ borderTop: '1px solid #eee' }}>
                  <td style={{ padding: 6 }}>{c.item}</td>
                  <td style={{ padding: 6, textAlign: 'right' }}>
                    <input
                      type="number"
                      step="0.01"
                      value={edited}
                      disabled={!canWriteConductDefaults}
                      onChange={(e) => setEditedConductPoints({ ...editedConductPoints, [c.item]: e.target.value })}
                      style={{ width: 90, padding: 4, textAlign: 'right' }}
                    />
                  </td>
                  <td style={{ padding: 6, textAlign: 'center' }}>
                    <button
                      disabled={!canWriteConductDefaults || !dirty || savingConductItem === c.item}
                      onClick={() => handleSaveConductDefault(c.item)}
                      style={{ fontSize: 12, padding: '4px 10px' }}
                    >
                      {savingConductItem === c.item ? '儲存中…' : '儲存'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 14, marginBottom: 8 }}>出缺席佔比（%）目前設定值</h2>
        <p style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
          「全勤」的加分比重（例如 3% → 全勤學生出缺席分數多 3 分）不是在這一頁設定，
          而是跟其他科目一樣，在「科目與比重設定」頁新增/編輯一個科目名稱為「全勤」或
          「出缺席」的列（依年級各自設定）。這裡列出目前資料庫裡已經有的設定值方便對照；
          要新增或修改，請到「科目與比重設定」頁操作。
        </p>
        {attendanceWeights.length === 0 ? (
          <p style={{ fontSize: 13, color: '#A36A2D' }}>
            目前資料庫裡查不到任何科目名稱為「全勤」或「出缺席」的比重設定──這代表對應年級的學生
            出缺席不會自動加分（曠課/事假等倒扣仍然照上面的點數計算，只是「全勤加分」那部分是 0）。
          </p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: 6 }}>學年/學期</th>
                <th style={{ textAlign: 'left', padding: 6 }}>年級</th>
                <th style={{ textAlign: 'left', padding: 6 }}>科目名稱</th>
                <th style={{ textAlign: 'right', padding: 6 }}>比重（換算成加分％）</th>
              </tr>
            </thead>
            <tbody>
              {attendanceWeights.map((w, i) => (
                <tr key={i} style={{ borderTop: '1px solid #eee' }}>
                  <td style={{ padding: 6 }}>{w.academic_year} {w.term}</td>
                  <td style={{ padding: 6 }}>{w.grade_level}</td>
                  <td style={{ padding: 6 }}>{w.subject}</td>
                  <td style={{ padding: 6, textAlign: 'right' }}>{(w.weight * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
