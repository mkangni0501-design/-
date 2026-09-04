import { supabase } from './supabaseClient';
import { resolveTeacherByName } from './bulkHandlers';

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

/* -------------------- 教務：操行成績（禮貌／衣著／服務／紀律） -------------------- */
// 格式跟 fetchCurrentConductScoresSheet() 下載出來的一致：學年度,部別,年級,班級,學期,
// 座號,學號,姓名,禮貌,衣著,服務,紀律（第2列起為資料）。用「學號＋學期」找目前在學的
// enrollment，四個分項只要有任一欄填了就寫入（沒填的欄位留 null，不會被當成0分蓋掉）。
export async function uploadConductScoresSheet(rowsRaw: any[][]): Promise<UploadResult> {
  let successCount = 0;
  const errors: string[] = [];
  for (let i = 1; i < rowsRaw.length; i++) {
    const r = rowsRaw[i];
    if (!r || r[6] == null || String(r[6]).trim() === '') continue; // 學號欄空白就跳過
    const studentNo = String(r[6]).trim();
    const term = String(r[4] ?? '').trim();
    try {
      if (!['上學期', '下學期'].includes(term)) throw new Error('學期要填「上學期」或「下學期」');
      const { data: enroll, error: enrollErr } = await supabase
        .from('enrollments')
        .select('id')
        .eq('student_no', studentNo)
        .eq('term', term)
        .eq('is_current', true)
        .maybeSingle();
      if (enrollErr) throw new Error(enrollErr.message);
      if (!enroll) throw new Error('找不到這個學號、這個學期目前在學的學籍');

      const { error } = await supabase.from('conduct_scores').upsert(
        {
          enrollment_id: enroll.id,
          politeness: toNum(r[8]),
          dress: toNum(r[9]),
          service: toNum(r[10]),
          discipline: toNum(r[11]),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'enrollment_id' }
      );
      if (error) throw new Error(error.message);
      successCount++;
    } catch (err: any) {
      errors.push(`第${i + 1}列（學號${studentNo}／${term}）：${err.message}`);
    }
  }
  return { successCount, errors };
}

/* -------------------- 開發人員：成績單樣式設定 -------------------- */
// 格式跟 fetchCurrentReportCardStyleSheet() 下載出來的一致：名稱,目前生效(V),設定內容(JSON)。
// 用「名稱」找既有樣式：有找到就更新，沒有就新增。勾了「目前生效」的話，會先把同校其他樣式
// 的 is_active 都設為 false（report_card_style 的設計是全校共用一份現在生效中的設定）。
export async function uploadReportCardStyleSheet(rowsRaw: any[][], updatedBy?: string | null): Promise<UploadResult> {
  let successCount = 0;
  const errors: string[] = [];
  for (let i = 1; i < rowsRaw.length; i++) {
    const r = rowsRaw[i];
    if (!r || r[0] == null || String(r[0]).trim() === '') continue;
    const name = String(r[0]).trim();
    try {
      const isActive = toBool(r[1]);
      const rawConfig = r[2];
      if (rawConfig == null || String(rawConfig).trim() === '') throw new Error('設定內容(JSON)欄位空白');
      let config: any;
      try {
        config = JSON.parse(String(rawConfig));
      } catch {
        throw new Error('設定內容不是合法的JSON格式，請整段搬移、不要手動修改');
      }
      if (isActive) {
        await supabase.from('report_card_style').update({ is_active: false }).eq('is_active', true);
      }
      const { data: existing } = await supabase.from('report_card_style').select('id').eq('name', name).maybeSingle();
      const payload = { name, config, is_active: isActive, updated_by: updatedBy ?? null, updated_at: new Date().toISOString() };
      const { error } = existing
        ? await supabase.from('report_card_style').update(payload).eq('id', existing.id)
        : await supabase.from('report_card_style').insert(payload);
      if (error) throw new Error(error.message);
      successCount++;
    } catch (err: any) {
      errors.push(`第${i + 1}列（${name}）：${err.message}`);
    }
  }
  return { successCount, errors };
}

/* -------------------- 教務：社團名冊（clubs + club_members） -------------------- */
// 格式跟 fetchCurrentClubRosterSheet() 下載出來的一致：社團名稱,學年度,學期,指導老師(校內),
// 外聘老師姓名,名額上限,固定節次,啟用中(V),學號,姓名,狀態(在社/退社)（第2列起為資料）。
// 社團本身用(名稱,學年度,學期)當唯一鍵（跟 sql/54 的 unique 限制一致）；學號/姓名/狀態
// 三欄空白的話，代表這一列只是用來建立/更新社團本身（例如還沒招生的新社團），不處理成員。
export async function uploadClubRosterSheet(rowsRaw: any[][]): Promise<UploadResult> {
  let successCount = 0;
  const errors: string[] = [];
  const clubIdCache = new Map<string, string>();
  for (let i = 1; i < rowsRaw.length; i++) {
    const r = rowsRaw[i];
    if (!r || r[0] == null || String(r[0]).trim() === '') continue;
    const clubName = String(r[0]).trim();
    const academicYear = toNum(r[1]);
    const term = String(r[2] ?? '').trim();
    const cacheKey = `${clubName}|${academicYear}|${term}`;
    try {
      if (academicYear == null) throw new Error('學年度要填數字');
      if (!['上學期', '下學期'].includes(term)) throw new Error('學期要填「上學期」或「下學期」');
      let clubId = clubIdCache.get(cacheKey);
      if (!clubId) {
        const teacherName = r[3] != null ? String(r[3]).trim() : '';
        const teacherId = teacherName ? await resolveTeacherByName(teacherName) : null;
        const { data: club, error: clubErr } = await supabase
          .from('clubs')
          .upsert(
            {
              name: clubName,
              academic_year: academicYear,
              term,
              teacher_id: teacherId,
              external_teacher_name: r[4] != null ? String(r[4]).trim() || null : null,
              capacity: toNum(r[5]),
              period_no: toNum(r[6]),
              is_active: r[7] != null ? toBool(r[7]) : true,
            },
            { onConflict: 'name,academic_year,term' }
          )
          .select('id')
          .single();
        if (clubErr) throw new Error(clubErr.message);
        clubId = club.id;
        clubIdCache.set(cacheKey, clubId!);
      }
      const studentNo = r[8] != null ? String(r[8]).trim() : '';
      if (studentNo) {
        const status = r[10] != null && String(r[10]).trim() ? String(r[10]).trim() : '在社';
        if (!['在社', '退社'].includes(status)) throw new Error('狀態要填「在社」或「退社」');
        const { error: memberErr } = await supabase
          .from('club_members')
          .upsert({ club_id: clubId, student_no: studentNo, status }, { onConflict: 'club_id,student_no' });
        if (memberErr) throw new Error(memberErr.message);
      }
      successCount++;
    } catch (err: any) {
      errors.push(`第${i + 1}列（${clubName}）：${err.message}`);
    }
  }
  return { successCount, errors };
}

/* -------------------- 教務：社團成績 -------------------- */
// 格式跟 fetchCurrentClubScoresSheet() 下載出來的一致：社團名稱,學年度,學期,學號,姓名,
// 期中考,期末考,平時分,已送出(V)（第2列起為資料）。社團要先存在（用「社團名冊」上傳過）
// 才能上傳成績，這裡不會順便建立社團。
export async function uploadClubScoresSheet(rowsRaw: any[][]): Promise<UploadResult> {
  let successCount = 0;
  const errors: string[] = [];
  const clubIdCache = new Map<string, string | null>();
  for (let i = 1; i < rowsRaw.length; i++) {
    const r = rowsRaw[i];
    if (!r || r[0] == null || String(r[0]).trim() === '' || r[3] == null || String(r[3]).trim() === '') continue;
    const clubName = String(r[0]).trim();
    const academicYear = toNum(r[1]);
    const term = String(r[2] ?? '').trim();
    const studentNo = String(r[3]).trim();
    const cacheKey = `${clubName}|${academicYear}|${term}`;
    try {
      if (academicYear == null) throw new Error('學年度要填數字');
      if (!['上學期', '下學期'].includes(term)) throw new Error('學期要填「上學期」或「下學期」');
      let clubId = clubIdCache.get(cacheKey);
      if (clubId === undefined) {
        const { data: club, error: clubErr } = await supabase
          .from('clubs')
          .select('id')
          .eq('name', clubName)
          .eq('academic_year', academicYear)
          .eq('term', term)
          .maybeSingle();
        if (clubErr) throw new Error(clubErr.message);
        clubId = club?.id ?? null;
        clubIdCache.set(cacheKey, clubId);
      }
      if (!clubId) throw new Error('找不到這個社團，請先透過「社團名冊」建立這個社團');
      const { error } = await supabase.from('club_scores').upsert(
        {
          club_id: clubId,
          student_no: studentNo,
          score_midterm: toNum(r[5]),
          score_final: toNum(r[6]),
          score_daily: toNum(r[7]),
          is_submitted: toBool(r[8]),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'club_id,student_no' }
      );
      if (error) throw new Error(error.message);
      successCount++;
    } catch (err: any) {
      errors.push(`第${i + 1}列（${clubName}／學號${studentNo}）：${err.message}`);
    }
  }
  return { successCount, errors };
}
