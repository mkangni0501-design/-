import { supabase } from './supabaseClient';

export type UploadResult = { successCount: number; errors: string[]; updatedCount?: number };

function toNum(v: any): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function toBool(v: any): boolean {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').trim().toUpperCase();
  return s === 'V' || s === 'TRUE' || s === '1' || s === '是';
}
function toDateOrNull(v: any): string | null {
  if (v == null || v === '') return null;
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return null;
}

/* -------------------- 訓導 -------------------- */

export async function uploadAttendanceAlertSettingsSheet(rowsRaw: any[][], updatedBy?: string | null): Promise<UploadResult> {
  const val = rowsRaw[1]?.[0];
  const threshold = toNum(val);
  if (threshold == null) return { successCount: 0, errors: ['第2列第1欄要填累計節數門檻的數字'] };
  const { error } = await supabase
    .from('attendance_alert_settings')
    .update({ threshold_periods: threshold, updated_by: updatedBy ?? null, updated_at: new Date().toISOString() })
    .eq('id', 1);
  return error ? { successCount: 0, errors: [error.message] } : { successCount: 1, errors: [] };
}

// conduct_point_defaults 用 item 當主鍵，同項目重新上傳＝修正原本的加扣分數字
export async function uploadConductPointDefaultsSheet(rowsRaw: any[][]): Promise<UploadResult> {
  let successCount = 0;
  const errors: string[] = [];
  for (let i = 1; i < rowsRaw.length; i++) {
    const r = rowsRaw[i];
    if (!r || r[0] == null || String(r[0]).trim() === '') continue;
    const item = String(r[0]).trim();
    const points = toNum(r[1]);
    if (points == null) {
      errors.push(`第${i + 1}列（${item}）：加扣分要填數字`);
      continue;
    }
    const { error } = await supabase.from('conduct_point_defaults').upsert({ item, points }, { onConflict: 'item' });
    if (error) errors.push(`第${i + 1}列（${item}）：${error.message}`);
    else successCount++;
  }
  return { successCount, errors };
}

/* -------------------- 總務 -------------------- */

// 品項沒有天然唯一鍵（同分類+同名可能真的是兩批不同規格的品項），這裡採「分類+品名+規格」
// 相同就更新、否則新增，跟本系統其他表的「批次修正」精神一致，但保守一點——規格有填的話
// 也要對上，避免不小心把不同規格的品項誤判成同一筆蓋掉。
export async function uploadGeneralInventoryItemsSheet(rowsRaw: any[][], createdBy?: string | null): Promise<UploadResult> {
  let successCount = 0;
  let updatedCount = 0;
  const errors: string[] = [];
  for (let i = 1; i < rowsRaw.length; i++) {
    const r = rowsRaw[i];
    if (!r || r[1] == null || String(r[1]).trim() === '') continue;
    const category = String(r[0] ?? '').trim();
    const name = String(r[1]).trim();
    const spec = r[2] != null ? String(r[2]).trim() || null : null;
    if (!['書庫', '校服', '簿本'].includes(category)) {
      errors.push(`第${i + 1}列（${name}）：分類要填「書庫」「校服」或「簿本」其中一種`);
      continue;
    }
    try {
      const payload = {
        category,
        name,
        spec,
        unit: r[3] != null ? String(r[3]).trim() || '件' : '件',
        unit_price: toNum(r[4]),
        note: r[6] != null ? String(r[6]).trim() || null : null,
      };
      let query = supabase.from('general_inventory_items').select('id').eq('category', category).eq('name', name);
      query = spec ? query.eq('spec', spec) : query.is('spec', null);
      const { data: existing } = await query.limit(1).maybeSingle();
      if (existing) {
        const { error } = await supabase.from('general_inventory_items').update(payload).eq('id', existing.id);
        if (error) throw new Error(error.message);
        updatedCount++;
      } else {
        const { error } = await supabase.from('general_inventory_items').insert({ ...payload, created_by: createdBy ?? null });
        if (error) throw new Error(error.message);
        successCount++;
      }
    } catch (err: any) {
      errors.push(`第${i + 1}列（${name}）：${err.message}`);
    }
  }
  return { successCount, errors, updatedCount };
}

// 進出紀錄本質是流水帳，重新上傳同一份不會「修正」既有紀錄（每一列都是一次獨立事件），
// 一律新增；要作廢/更正請直接新增一筆「調整」方向的紀錄抵銷，不要在這裡改歷史紀錄。
export async function uploadGeneralInventoryTransactionsSheet(rowsRaw: any[][], recordedBy?: string | null): Promise<UploadResult> {
  let successCount = 0;
  const errors: string[] = [];
  const { data: items } = await supabase.from('general_inventory_items').select('id, name');
  const itemByName = new Map((items ?? []).map((it: any) => [it.name, it.id]));
  for (let i = 1; i < rowsRaw.length; i++) {
    const r = rowsRaw[i];
    if (!r || r[0] == null || String(r[0]).trim() === '') continue;
    const itemName = String(r[0]).trim();
    try {
      const itemId = itemByName.get(itemName);
      if (!itemId) throw new Error('找不到這個品名，請先在「總務庫存品項」建立這個品項');
      const direction = String(r[1] ?? '').trim();
      if (!['入庫', '售出', '借出', '歸還', '調整', '報損'].includes(direction)) throw new Error('方向要填「入庫/售出/借出/歸還/調整/報損」其中一種');
      const quantity = toNum(r[2]);
      if (quantity == null || quantity <= 0) throw new Error('數量要填大於0的數字');
      const { error } = await supabase.from('general_inventory_transactions').insert({
        item_id: itemId,
        direction,
        quantity,
        unit_price_at_time: toNum(r[3]),
        counterparty: r[4] != null ? String(r[4]).trim() || null : null,
        note: r[5] != null ? String(r[5]).trim() || null : null,
        recorded_by: recordedBy ?? null,
      });
      if (error) throw new Error(error.message);
      successCount++;
    } catch (err: any) {
      errors.push(`第${i + 1}列（${itemName}）：${err.message}`);
    }
  }
  return { successCount, errors };
}

// 修繕案件也是逐案追蹤，一律新增；要更新既有案件狀態請到「修繕登記」頁面直接改，不透過批次上傳覆蓋。
export async function uploadMaintenanceTicketsSheet(rowsRaw: any[][], reportedBy?: string | null): Promise<UploadResult> {
  let successCount = 0;
  const errors: string[] = [];
  for (let i = 1; i < rowsRaw.length; i++) {
    const r = rowsRaw[i];
    if (!r || r[0] == null || String(r[0]).trim() === '') continue;
    const location = String(r[0]).trim();
    try {
      const status = r[2] != null && String(r[2]).trim() ? String(r[2]).trim() : '待處理';
      if (!['待處理', '處理中', '已完成', '取消'].includes(status)) throw new Error('狀態要填「待處理/處理中/已完成/取消」其中一種');
      const { error } = await supabase.from('maintenance_tickets').insert({
        location,
        issue: String(r[1] ?? '').trim(),
        status,
        assigned_to: r[3] != null ? String(r[3]).trim() || null : null,
        note: r[6] != null ? String(r[6]).trim() || null : null,
        reported_by: reportedBy ?? null,
      });
      if (error) throw new Error(error.message);
      successCount++;
    } catch (err: any) {
      errors.push(`第${i + 1}列（${location}）：${err.message}`);
    }
  }
  return { successCount, errors };
}

// utility_bills 有 unique(category, billing_month)，同月份同類別重新上傳＝修正金額/繳費狀態
export async function uploadUtilityBillsSheet(rowsRaw: any[][], recordedBy?: string | null): Promise<UploadResult> {
  let successCount = 0;
  const errors: string[] = [];
  for (let i = 1; i < rowsRaw.length; i++) {
    const r = rowsRaw[i];
    if (!r || r[0] == null || String(r[0]).trim() === '') continue;
    const category = String(r[0]).trim();
    try {
      if (!['水費', '電費', '網路費', '其他'].includes(category)) throw new Error('類別要填「水費/電費/網路費/其他」其中一種');
      const billing_month = toDateOrNull(r[1]);
      if (!billing_month) throw new Error('帳單月份必填');
      const amount = toNum(r[2]);
      if (amount == null) throw new Error('金額必填');
      const { error } = await supabase.from('utility_bills').upsert(
        {
          category,
          billing_month,
          amount,
          paid: toBool(r[3]),
          paid_date: toDateOrNull(r[4]),
          note: r[5] != null ? String(r[5]).trim() || null : null,
          recorded_by: recordedBy ?? null,
        },
        { onConflict: 'category,billing_month' }
      );
      if (error) throw new Error(error.message);
      successCount++;
    } catch (err: any) {
      errors.push(`第${i + 1}列（${category}）：${err.message}`);
    }
  }
  return { successCount, errors };
}

/* -------------------- 開發人員 -------------------- */

// academic_terms 有 unique(academic_year, term)，同學年學期重新上傳＝修正起訖日/狀態；
// 「目前生效」勾了會先把其他學期取消勾選（資料庫本來就限定同時只能有一筆is_current=true）。
export async function uploadAcademicTermsSheet(rowsRaw: any[][], createdBy?: string | null): Promise<UploadResult> {
  let successCount = 0;
  const errors: string[] = [];
  for (let i = 1; i < rowsRaw.length; i++) {
    const r = rowsRaw[i];
    if (!r || r[0] == null || String(r[0]).trim() === '') continue;
    const academic_year = toNum(r[0]);
    const term = String(r[1] ?? '').trim();
    try {
      if (academic_year == null) throw new Error('學年度要填數字');
      if (!['上學期', '下學期'].includes(term)) throw new Error('學期要填「上學期」或「下學期」');
      const is_current = toBool(r[4]);
      if (is_current) {
        await supabase.from('academic_terms').update({ is_current: false }).neq('academic_year', -1);
      }
      const status = r[5] != null && String(r[5]).trim() ? String(r[5]).trim() : '規劃中';
      const { error } = await supabase.from('academic_terms').upsert(
        {
          academic_year,
          term,
          term_start_date: toDateOrNull(r[2]),
          term_end_date: toDateOrNull(r[3]),
          is_current,
          status,
          created_by: createdBy ?? null,
        },
        { onConflict: 'academic_year,term' }
      );
      if (error) throw new Error(error.message);
      successCount++;
    } catch (err: any) {
      errors.push(`第${i + 1}列（${academic_year}學年度${term}）：${err.message}`);
    }
  }
  return { successCount, errors };
}
