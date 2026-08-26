'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useDepartmentPermissions } from '@/lib/useDepartmentPermissions';
import { writeGoverned } from '@/lib/pendingChanges';
import { isDepartmentLead } from '@/lib/departments';
import PendingChangesReviewPanel from '@/components/PendingChangesReviewPanel';
import MyPendingChangesList from '@/components/MyPendingChangesList';
import ExcelUploadButton from '@/components/ExcelUploadButton';
import TemplateDownloadButton from '@/components/TemplateDownloadButton';

// 校服／簿本庫存販賣表：依使用者提供的參考原型（總.zip 的 v9.html「總務處販賣與庫存系統」）
// 重新製作，保留原型的三分頁（販賣作業／採購作業／表格下載）、庫存警示側欄、快速補貨、
// 新增商品上架、品項名稱/單價/警戒值即改即用設定表、每日統計與交易明細、
// 依單價分組的 Excel 格式列印/下載表格。跟原型不同的地方：
//  - 原型是純前端 demo，資料存在瀏覽器記憶體，重新整理就消失；這裡改接到 Supabase
//    的 general_inventory_items / general_inventory_transactions（跟「書庫」共用同一組資料表，
//    用 category 區分），資料庫本來就有「庫存＝進出紀錄加總」的觸發器自動維護，不用自己算。
//  - 原型的「服裝區／學用品區」是同一頁兩個分區；這裡校服跟簿本本來就是各自獨立的頁面
//    （網址不同），所以只呈現對應這個分類的單一分區即可，不用重複另一區。
//  - 「總務承辦人員(staff)」的新增/登記一律照全站慣例走送審機制（總務主管核准後才真正
//    寫入/更新庫存），原型沒有這層權限概念。
//  - 樣本圖片上傳維持跟原型一樣「只在瀏覽器本機預覽、不會上傳/保存」，重新整理就會消失
//    （原型本來也是這樣，這裡沒有另外接圖床/雲端空間）。

type Mode = 'sale' | 'purchase' | 'print';

type Item = {
  id: string;
  category: '校服' | '簿本';
  name: string;
  spec: string | null;
  unit: string;
  unit_price: number | null;
  quantity_on_hand: number;
  low_stock_threshold: number;
  note: string | null;
};

type Tx = {
  id: string;
  item_id: string;
  direction: string;
  quantity: number;
  unit_price_at_time: number | null;
  note: string | null;
  recorded_at: string;
};

const DIRECTIONS: Record<Mode, string> = { sale: '售出', purchase: '入庫', print: '' };

function formatDate(d: Date) {
  return `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, '0')}月${String(d.getDate()).padStart(2, '0')}日`;
}
function formatDateTime(d: Date) {
  return `${formatDate(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function dateKey(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export default function SalesInventoryPage({
  category,
  title,
  itemLabel,
  hint,
}: {
  category: '校服' | '簿本';
  title: string;
  itemLabel: string; // 側欄/表格上顯示的分區名稱，例如「服裝」「學用品」
  hint: string;
}) {
  const perms = useDepartmentPermissions();
  const canWriteDirect = perms.isSystemAdmin || isDepartmentLead(perms.myDepartments, 'general');

  const [items, setItems] = useState<Item[]>([]);
  const [txs, setTxs] = useState<Tx[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('sale');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [selected, setSelected] = useState<Record<string, { checked: boolean; qty: string }>>({});
  const [restockItemId, setRestockItemId] = useState('');
  const [restockQty, setRestockQty] = useState('1');
  const [sampleImage, setSampleImage] = useState<string | null>(null);
  const [newItem, setNewItem] = useState({ name: '', price: '', stock: '', threshold: '3' });
  const [busy, setBusy] = useState(false);

  async function load() {
    const [itemsRes, txRes] = await Promise.all([
      supabase.from('general_inventory_items').select('*').eq('category', category).order('name'),
      supabase
        .from('general_inventory_transactions')
        .select('id, item_id, direction, quantity, unit_price_at_time, note, recorded_at, general_inventory_items!inner(category)')
        .eq('general_inventory_items.category', category)
        .order('recorded_at', { ascending: false })
        .limit(300),
    ]);
    setLoadError(itemsRes.error ? '讀取品項失敗：' + itemsRes.error.message : txRes.error ? '讀取紀錄失敗：' + txRes.error.message : null);
    setItems((itemsRes.data ?? []) as Item[]);
    setTxs((txRes.data ?? []) as unknown as Tx[]);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category]);

  const lowStockItems = useMemo(() => items.filter((i) => i.quantity_on_hand <= i.low_stock_threshold), [items]);

  // 一旦有庫存不足的品項，跟原型一樣自動把側欄打開提醒，不用使用者自己點開才看得到
  useEffect(() => {
    if (lowStockItems.length > 0) setSidebarOpen(true);
  }, [lowStockItems.length]);

  const todayRevenue = useMemo(() => {
    const today = dateKey(new Date().toISOString());
    return txs
      .filter((t) => t.direction === '售出' && dateKey(t.recorded_at) === today)
      .reduce((sum, t) => sum + t.quantity * (t.unit_price_at_time ?? 0), 0);
  }, [txs]);

  const currentTotal = useMemo(() => {
    return items.reduce((sum, i) => {
      const sel = selected[i.id];
      if (!sel?.checked) return sum;
      const qty = parseInt(sel.qty) || 0;
      return sum + qty * (i.unit_price ?? 0);
    }, 0);
  }, [items, selected]);

  const dailySummary = useMemo(() => {
    const map: Record<string, { direction: string; qty: number; amount: number }> = {};
    txs.forEach((t) => {
      const label = `${dateKey(t.recorded_at).replace(/-/g, '/')}（${t.direction}）`;
      map[label] = map[label] ?? { direction: t.direction, qty: 0, amount: 0 };
      map[label].qty += t.quantity;
      map[label].amount += t.quantity * (t.unit_price_at_time ?? 0);
    });
    return Object.entries(map);
  }, [txs]);

  function toggleItem(id: string) {
    setSelected((prev) => ({ ...prev, [id]: { checked: !prev[id]?.checked, qty: '1' } }));
  }
  function setQty(id: string, qty: string) {
    setSelected((prev) => ({ ...prev, [id]: { checked: prev[id]?.checked ?? true, qty } }));
  }

  async function handleSampleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setSampleImage(reader.result as string);
    reader.readAsDataURL(file);
  }

  async function handleCheckout() {
    if (!perms.userId) return;
    const picks = items
      .map((i) => ({ item: i, sel: selected[i.id] }))
      .filter((p) => p.sel?.checked);
    if (picks.length === 0) {
      alert('請至少勾選一項商品！');
      return;
    }
    for (const { item, sel } of picks) {
      const qty = parseInt(sel.qty) || 0;
      if (qty <= 0) {
        alert(`${item.name} 的數量必須大於 0`);
        return;
      }
      if (mode === 'sale' && qty > item.quantity_on_hand) {
        alert(`${item.name} 庫存不足！目前僅剩 ${item.quantity_on_hand}`);
        return;
      }
    }

    setBusy(true);
    let pendingCount = 0;
    let errorMsg: string | null = null;
    for (const { item, sel } of picks) {
      const qty = parseInt(sel.qty) || 0;
      const { error, pending } = await writeGoverned(
        'general_inventory_transactions',
        'insert',
        {
          item_id: item.id,
          direction: DIRECTIONS[mode],
          quantity: qty,
          unit_price_at_time: item.unit_price,
          recorded_by: perms.userId,
        },
        { myDepartments: perms.myDepartments, isSystemAdmin: perms.isSystemAdmin, requestedBy: perms.userId }
      );
      if (error) errorMsg = error;
      if (pending) pendingCount++;
    }
    setBusy(false);
    setSelected({});
    load();
    if (errorMsg) {
      alert('部分項目寫入失敗：' + errorMsg);
    } else if (pendingCount > 0) {
      alert('已送出申請，等總務主管核准後庫存才會更新。');
    } else {
      alert(mode === 'sale' ? '結帳成功！已扣除庫存並寫入紀錄。' : '採購成功！已增加庫存並寫入紀錄。');
    }
  }

  async function handleQuickRestock() {
    if (!perms.userId) return;
    const item = items.find((i) => i.id === restockItemId);
    const qty = parseInt(restockQty) || 0;
    if (!item) {
      alert('請選擇有效的商品！');
      return;
    }
    if (qty <= 0) {
      alert('補貨數量必須大於 0！');
      return;
    }
    const { error, pending } = await writeGoverned(
      'general_inventory_transactions',
      'insert',
      { item_id: item.id, direction: '入庫', quantity: qty, unit_price_at_time: item.unit_price, note: '快速補貨', recorded_by: perms.userId },
      { myDepartments: perms.myDepartments, isSystemAdmin: perms.isSystemAdmin, requestedBy: perms.userId }
    );
    if (error) {
      alert('補貨失敗：' + error);
      return;
    }
    setRestockQty('1');
    load();
    alert(pending ? '已送出補貨申請，等總務主管核准後庫存才會更新。' : `【${item.name}】補貨成功！增加 ${qty} 個。`);
  }

  async function handleAddNewItem() {
    if (!perms.userId) return;
    const name = newItem.name.trim();
    const price = parseInt(newItem.price);
    const stock = parseInt(newItem.stock || '0');
    const threshold = parseInt(newItem.threshold || '3');
    if (!name) return alert('請輸入商品名稱！');
    if (items.some((i) => i.name === name)) return alert('此商品名稱已存在！');
    if (isNaN(price) || price < 0) return alert('請輸入有效價格！');
    if (isNaN(stock) || stock < 0) return alert('請輸入有效庫存！');

    const { error, pending, data } = await writeGoverned(
      'general_inventory_items',
      'insert',
      { category, name, unit: '件', unit_price: price, low_stock_threshold: isNaN(threshold) ? 3 : threshold, created_by: perms.userId },
      { myDepartments: perms.myDepartments, isSystemAdmin: perms.isSystemAdmin, requestedBy: perms.userId }
    );
    if (error) return alert('新增失敗：' + error);

    if (!pending && data?.id && stock > 0) {
      // 直接寫入的情況才拿得到剛建立的品項 id，才能順便補上「初始庫存」這筆入庫紀錄；
      // 送審(staff)的情況品項本身都還沒真的建立，沒有 id 可用，只能等核准後再用「快速補貨」補上。
      await writeGoverned(
        'general_inventory_transactions',
        'insert',
        { item_id: data.id, direction: '入庫', quantity: stock, unit_price_at_time: price, note: '新商品初始庫存', recorded_by: perms.userId },
        { myDepartments: perms.myDepartments, isSystemAdmin: perms.isSystemAdmin, requestedBy: perms.userId }
      );
    }

    setNewItem({ name: '', price: '', stock: '', threshold: '3' });
    load();
    if (pending) {
      alert(`新商品【${name}】新增申請已送出，等總務主管核准後才會上架；核准後請再用「現有商品直接補貨」補上初始庫存。`);
    } else {
      alert(`新商品【${name}】新增成功！已自動歸類至系統與表格下載頁面。`);
    }
  }

  // 一鍵上傳：跟「新進商品並自動上架」一筆一筆手動填是同一套邏輯，只是改成一次貼上一整批
  // Excel，逐列呼叫，方便總務一次把整批新商品（例如開學前新進的一批校服/簿本）建檔上架，
  // 不用每個品項各自手動填一次表單。
  async function handleDownloadUploadTemplate() {
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      [`${itemLabel}名稱`, '單價', '初始庫存', '警戒值', '備註'],
      [`↓從第2列開始才是資料。${itemLabel}名稱不能跟現有品項重複，警戒值不填預設為3`, '', '', '', ''],
      [`範例${itemLabel}`, 100, 20, 3, ''],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, `${itemLabel}一鍵上傳`);
    XLSX.writeFile(wb, `${itemLabel}一鍵上傳_範本.xlsx`);
  }

  async function handleBulkUploadFile(file: File): Promise<{ successCount: number; errors: string[] }> {
    if (!perms.userId) return { successCount: 0, errors: ['請重新登入'] };
    const XLSX = await import('xlsx');
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rowsRaw: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

    let successCount = 0;
    const errors: string[] = [];
    // 跟畫面上「新增品項」一樣的邏輯，逐列比對重複名稱（含這批檔案裡自己前面已經上傳成功的），
    // 直接寫入(lead/系統管理員S)的話順便補一筆「初始庫存」入庫紀錄；送審(staff)的話等核准後
    // 要再用「現有商品直接補貨」補上初始庫存，跟單筆新增一致。
    const existingNames = new Set(items.map((i) => i.name));

    for (let r = 1; r < rowsRaw.length; r++) {
      const row = rowsRaw[r];
      if (!row || row.every((c) => c == null || c === '')) continue;
      const name = String(row[0] ?? '').trim();
      if (!name) continue;
      if (name.startsWith('↓')) continue; // 跳過範本的說明列
      if (existingNames.has(name)) {
        errors.push(`第${r + 1}列「${name}」：品項名稱已存在，已略過`);
        continue;
      }
      const price = Number(row[1] ?? 0);
      const stock = Number(row[2] ?? 0);
      const threshold = row[3] != null && row[3] !== '' ? Number(row[3]) : 3;
      const note = row[4] != null ? String(row[4]) : null;
      if (isNaN(price) || price < 0) {
        errors.push(`第${r + 1}列「${name}」：單價格式錯誤，已略過`);
        continue;
      }
      if (isNaN(stock) || stock < 0) {
        errors.push(`第${r + 1}列「${name}」：初始庫存格式錯誤，已略過`);
        continue;
      }

      const { error, pending, data } = await writeGoverned(
        'general_inventory_items',
        'insert',
        { category, name, unit: '件', unit_price: price, low_stock_threshold: isNaN(threshold) ? 3 : threshold, note, created_by: perms.userId },
        { myDepartments: perms.myDepartments, isSystemAdmin: perms.isSystemAdmin, requestedBy: perms.userId }
      );
      if (error) {
        errors.push(`第${r + 1}列「${name}」：${error}`);
        continue;
      }
      if (!pending && data?.id && stock > 0) {
        await writeGoverned(
          'general_inventory_transactions',
          'insert',
          { item_id: data.id, direction: '入庫', quantity: stock, unit_price_at_time: price, note: '一鍵上傳初始庫存', recorded_by: perms.userId },
          { myDepartments: perms.myDepartments, isSystemAdmin: perms.isSystemAdmin, requestedBy: perms.userId }
        );
      }
      existingNames.add(name);
      successCount++;
    }

    load();
    return { successCount, errors };
  }

  async function handleUpdateItem(item: Item, patch: Partial<Pick<Item, 'name' | 'unit_price' | 'low_stock_threshold'>>) {
    if (!perms.userId) return;
    if (patch.name != null) {
      const newName = patch.name.trim();
      if (!newName) return alert('商品名稱不能為空！');
      if (items.some((i) => i.id !== item.id && i.name === newName)) return alert('此商品名稱已存在！');
    }
    const { error, pending } = await writeGoverned('general_inventory_items', 'update', patch, {
      myDepartments: perms.myDepartments,
      isSystemAdmin: perms.isSystemAdmin,
      requestedBy: perms.userId,
      recordKey: item.id,
      beforeSnapshot: item,
    });
    if (error) {
      alert('儲存失敗：' + error);
      return;
    }
    load();
    if (pending) alert('已送出修改申請，等總務主管核准後才會生效。');
  }

  async function handleDeleteItem(item: Item) {
    if (!perms.userId) return;
    if (!confirm(`確定要刪除「${item.name}」嗎？這個品項底下所有的進出紀錄也會一併被刪除，無法復原！`)) return;
    const { error, pending } = await writeGoverned('general_inventory_items', 'delete', {}, {
      myDepartments: perms.myDepartments,
      isSystemAdmin: perms.isSystemAdmin,
      requestedBy: perms.userId,
      recordKey: item.id,
      beforeSnapshot: item,
    });
    if (error) {
      alert('刪除失敗：' + error);
      return;
    }
    load();
    if (pending) alert('已送出刪除申請，等總務主管核准後才會真正刪除。');
  }

  async function handleDownloadTable() {
    const byPrice: Record<number, string[]> = {};
    items.forEach((i) => {
      const p = i.unit_price ?? 0;
      byPrice[p] = byPrice[p] ?? [];
      byPrice[p].push(i.name);
    });
    const rows: (string | number)[][] = [
      [`總務處${itemLabel}販賣登記表`],
      [`日期：＿＿＿年＿＿月＿＿日　填表人：＿＿＿＿＿＿＿＿`],
      [],
      ['單價', `${itemLabel} & 件數（請填寫數量）`, '總數', '總價', '日期'],
      ...Object.entries(byPrice)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([price, names]) => [Number(price), names.map((n) => `${n} __`).join('  '), '', '', '']),
    ];
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), `${itemLabel}販賣登記表`);
    XLSX.writeFile(wb, `${title}_${formatDate(new Date())}.xlsx`);
  }

  const priceGroups = useMemo(() => {
    const byPrice: Record<number, Item[]> = {};
    items.forEach((i) => {
      const p = i.unit_price ?? 0;
      byPrice[p] = byPrice[p] ?? [];
      byPrice[p].push(i);
    });
    return Object.entries(byPrice).sort((a, b) => Number(a[0]) - Number(b[0]));
  }, [items]);

  if (perms.loading) return null;

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: 24, display: 'flex', gap: 20, alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h1 style={{ fontSize: 16, marginBottom: 4 }}>{title}</h1>
            <p style={{ fontSize: 12, color: '#666', marginBottom: 12 }}>{hint}</p>
          </div>
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            style={{ padding: '8px 14px', background: '#34495e', color: '#fff', border: 'none', borderRadius: 20, fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}
          >
            📊 資訊側邊欄{lowStockItems.length > 0 ? `（${lowStockItems.length}）` : ''}
          </button>
        </div>
        {loadError && <p style={{ fontSize: 13, color: '#A32D2D', marginBottom: 12 }}>{loadError}</p>}

        {!canWriteDirect && perms.userId && (
          <p style={{ fontSize: 12, color: '#A36A00', background: '#FFF8E1', border: '1px solid #f0d98a', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
            您的帳號是總務承辦人員，這裡的新增／結帳／補貨會先送給總務主管核准，核准後庫存數量才會更新。
          </p>
        )}
        <PendingChangesReviewPanel
          department="general"
          reviewerId={perms.userId ?? ''}
          canReview={isDepartmentLead(perms.myDepartments, 'general') || perms.isSystemAdmin}
          onReviewed={load}
        />

        <div style={{ display: 'flex', gap: 8, marginBottom: 14, borderBottom: '2px solid #ddd', paddingBottom: 10 }}>
          {(['sale', 'purchase', 'print'] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                padding: '8px 16px',
                border: 'none',
                borderRadius: 4,
                fontWeight: 700,
                cursor: 'pointer',
                fontSize: 14,
                background: mode === m ? (m === 'sale' ? '#27ae60' : m === 'purchase' ? '#2980b9' : '#8e44ad') : '#e0e0e0',
                color: mode === m ? '#fff' : '#555',
              }}
            >
              {m === 'sale' ? '🏷️ 販賣作業（出貨）' : m === 'purchase' ? '🛒 採購作業（進貨）' : '📋 表格下載'}
            </button>
          ))}
        </div>

        {mode !== 'print' ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-around', background: '#eef2f5', padding: 12, borderRadius: 8, marginBottom: 20 }}>
              <div style={{ textAlign: 'center' }}>
                <h3 style={{ margin: 0, color: '#555', fontSize: 13 }}>
                  {mode === 'sale' ? `今日總收入（${formatDate(new Date())}）` : `今日總支出（${formatDate(new Date())}）`}
                </h3>
                <p style={{ margin: '5px 0 0', fontSize: 20, fontWeight: 700, color: '#2c3e50' }}>${todayRevenue}</p>
              </div>
              <div style={{ textAlign: 'center' }}>
                <h3 style={{ margin: 0, color: '#555', fontSize: 13 }}>{mode === 'sale' ? '本次結帳總額' : '本次採購總額'}</h3>
                <p style={{ margin: '5px 0 0', fontSize: 20, fontWeight: 700, color: '#2c3e50' }}>${currentTotal}</p>
              </div>
            </div>

            <h3 style={{ background: '#34495e', color: '#fff', padding: '6px 10px', borderRadius: 4, fontSize: 15, marginBottom: 10 }}>
              {itemLabel}區（勾選後填寫數量）
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10, marginBottom: 20 }}>
              {items.map((i) => {
                const isLow = i.quantity_on_hand <= i.low_stock_threshold;
                const sel = selected[i.id];
                return (
                  <div
                    key={i.id}
                    style={{ background: '#fff', border: '1px solid #ddd', padding: 10, borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                      <input type="checkbox" checked={!!sel?.checked} onChange={() => toggleItem(i.id)} style={{ marginTop: 4 }} />
                      <label>
                        <span style={isLow ? { color: 'red', fontSize: '1.4em', fontWeight: 700, lineHeight: 1.2 } : undefined}>{i.name}</span>{' '}
                        <span style={{ color: '#e67e22', fontWeight: 700, fontSize: 13 }}>(${i.unit_price ?? 0})</span>
                        <br />
                        <span style={{ fontSize: 11, color: '#7f8c8d' }}>
                          庫存: {i.quantity_on_hand}（警戒: {i.low_stock_threshold}）
                        </span>
                      </label>
                    </div>
                    {sel?.checked && (
                      <input
                        type="number"
                        min={1}
                        max={mode === 'sale' ? Math.max(i.quantity_on_hand, 1) : 999}
                        value={sel.qty}
                        onChange={(e) => setQty(i.id, e.target.value)}
                        style={{ width: 50, padding: 5, border: '1px solid #ccc', borderRadius: 4 }}
                      />
                    )}
                  </div>
                );
              })}
              {items.length === 0 && <p style={{ color: '#999', fontSize: 13 }}>目前沒有品項，請從右側「新進商品並自動上架」新增。</p>}
            </div>

            <button
              onClick={handleCheckout}
              disabled={busy}
              style={{
                background: mode === 'sale' ? '#27ae60' : '#2980b9',
                color: '#fff',
                border: 'none',
                padding: '12px 20px',
                fontSize: 16,
                borderRadius: 4,
                cursor: 'pointer',
                width: '100%',
                fontWeight: 700,
              }}
            >
              {busy ? '處理中…' : mode === 'sale' ? (canWriteDirect ? '確認結帳並扣除庫存' : '送出結帳申請') : canWriteDirect ? '確認採購並增加庫存' : '送出採購申請'}
            </button>
          </>
        ) : (
          <div style={{ background: '#fff', padding: 20, borderRadius: 6, border: '1px solid #ddd' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 }}>
              <h3 style={{ margin: 0, color: '#2c3e50' }}>📋 {title}（Excel 格式）</h3>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={handleDownloadTable} style={{ background: '#2C6E9E', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: 4, fontWeight: 700, cursor: 'pointer' }}>
                  ⬇️ 下載 Excel
                </button>
                <button onClick={() => window.print()} style={{ background: '#8e44ad', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: 4, fontWeight: 700, cursor: 'pointer' }}>
                  🖨️ 直接列印表單
                </button>
              </div>
            </div>
            <div style={{ textAlign: 'center', marginBottom: 10 }}>
              <h2 style={{ margin: '0 0 5px', fontSize: 18, color: '#000' }}>{title}</h2>
              <p style={{ margin: 0, fontSize: 13, color: '#333' }}>日期：_______年_______月_______日　填表人：____________</p>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr>
                  {['單價', `${itemLabel} & 件數（請填寫數量）`, '總數', '總價', '日期'].map((h) => (
                    <th key={h} style={{ border: '1px solid #222', padding: '6px 8px', background: '#e2e8f0', color: '#000' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {priceGroups.map(([price, group]) => (
                  <tr key={price}>
                    <td style={{ border: '1px solid #222', padding: '6px 8px', fontWeight: 700, color: '#000' }}>${price}</td>
                    <td style={{ border: '1px solid #222', padding: '6px 8px', textAlign: 'left', fontWeight: 700, color: '#000' }}>
                      {group.map((i) => `${i.name} __`).join('   ')}
                    </td>
                    <td style={{ border: '1px solid #222', padding: '6px 8px' }}></td>
                    <td style={{ border: '1px solid #222', padding: '6px 8px' }}></td>
                    <td style={{ border: '1px solid #222', padding: '6px 8px' }}></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {sidebarOpen && (
        <div style={{ width: 340, flexShrink: 0, background: '#fff', border: '1px solid #eee', borderRadius: 8, padding: 16, position: 'sticky', top: 16, maxHeight: 'calc(100vh - 32px)', overflowY: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '2px solid #eee', paddingBottom: 10, marginBottom: 12 }}>
            <h2 style={{ fontSize: 14, margin: 0 }}>資訊面板</h2>
            <button onClick={() => setSidebarOpen(false)} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#7f8c8d' }}>
              ✕
            </button>
          </div>

          <details open style={{ marginBottom: 14, border: '1px solid #ddd', borderRadius: 5, padding: 10, background: '#fafafa' }}>
            <summary style={{ fontWeight: 700, cursor: 'pointer', color: '#2c3e50', fontSize: 14 }}>⚠️ 庫存不足警示（{lowStockItems.length}）</summary>
            <div style={{ maxHeight: 150, overflowY: 'auto', marginTop: 8 }}>
              {lowStockItems.length === 0 ? (
                <p style={{ color: 'green', fontSize: 13 }}>目前所有品項庫存充足</p>
              ) : (
                lowStockItems.map((i) => (
                  <div key={i.id} style={{ color: 'red', fontWeight: 700, marginBottom: 5, fontSize: 13, display: 'flex', justifyContent: 'space-between' }}>
                    <span>⚠️ {i.name}</span>
                    <span>
                      剩餘: {i.quantity_on_hand} / 警戒: {i.low_stock_threshold}
                    </span>
                  </div>
                ))
              )}
            </div>
          </details>

          <details style={{ marginBottom: 14, border: '1px solid #ddd', borderRadius: 5, padding: 10, background: '#fafafa' }}>
            <summary style={{ fontWeight: 700, cursor: 'pointer', color: '#2c3e50', fontSize: 14 }}>🖼️ 上傳販賣物品樣本</summary>
            <div style={{ padding: '5px 0' }}>
              <div style={{ border: '2px dashed #3498db', padding: 10, borderRadius: 6, background: '#f8fafc', textAlign: 'center', marginBottom: 10 }}>
                {sampleImage ? (
                  <>
                    <img src={sampleImage} alt="販賣物品樣本" style={{ maxWidth: '100%', maxHeight: 140, borderRadius: 4 }} />
                    <br />
                    <span style={{ fontSize: 11, color: '#27ae60', fontWeight: 700 }}>樣本載入成功</span>
                  </>
                ) : (
                  <span style={{ fontSize: 12, color: '#7f8c8d' }}>尚未上傳樣本圖片</span>
                )}
              </div>
              <input type="file" accept="image/*" onChange={handleSampleUpload} style={{ width: '100%', fontSize: 12, marginBottom: 5 }} />
              <button
                onClick={() => setSampleImage(null)}
                style={{ background: '#e74c3c', color: '#fff', border: 'none', padding: 5, width: '100%', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 700 }}
              >
                清除樣本圖片
              </button>
              <p style={{ fontSize: 11, color: '#999', marginTop: 6 }}>樣本圖片僅在本機瀏覽器預覽，不會上傳或保存，重新整理頁面就會消失。</p>
            </div>
          </details>

          <details open style={{ marginBottom: 14, border: '1px solid #ddd', borderRadius: 5, padding: 10, background: '#fafafa' }}>
            <summary style={{ fontWeight: 700, cursor: 'pointer', color: '#2c3e50', fontSize: 14 }}>➕ 快速補貨與新商品上架</summary>
            <div style={{ padding: '5px 0' }}>
              <h4 style={{ margin: '5px 0', fontSize: 13, color: '#34495e' }}>📦 現有商品直接補貨</h4>
              <select value={restockItemId} onChange={(e) => setRestockItemId(e.target.value)} style={{ width: '100%', padding: 6, marginBottom: 5, border: '1px solid #ccc', borderRadius: 4, boxSizing: 'border-box' }}>
                <option value="">選擇商品</option>
                {items.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}（現有庫存: {i.quantity_on_hand}）
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={1}
                value={restockQty}
                onChange={(e) => setRestockQty(e.target.value)}
                placeholder="補貨數量"
                style={{ width: '100%', padding: 6, marginBottom: 5, border: '1px solid #ccc', borderRadius: 4, boxSizing: 'border-box' }}
              />
              <button
                onClick={handleQuickRestock}
                style={{ background: '#2980b9', color: '#fff', border: 'none', padding: 7, width: '100%', borderRadius: 4, cursor: 'pointer', fontWeight: 700, fontSize: 13 }}
              >
                直接補貨增加庫存
              </button>

              <h4 style={{ margin: '14px 0 5px', fontSize: 13, color: '#34495e' }}>✨ 新進商品並自動上架</h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <input
                  placeholder={`新${itemLabel}名稱`}
                  value={newItem.name}
                  onChange={(e) => setNewItem({ ...newItem, name: e.target.value })}
                  style={{ padding: 6, border: '1px solid #ccc', borderRadius: 4, boxSizing: 'border-box' }}
                />
                <div style={{ display: 'flex', gap: 5 }}>
                  <input
                    type="number"
                    min={0}
                    placeholder="價格 ($)"
                    value={newItem.price}
                    onChange={(e) => setNewItem({ ...newItem, price: e.target.value })}
                    style={{ flex: 1, padding: 6, border: '1px solid #ccc', borderRadius: 4, boxSizing: 'border-box' }}
                  />
                  <input
                    type="number"
                    min={0}
                    placeholder="初始庫存"
                    value={newItem.stock}
                    onChange={(e) => setNewItem({ ...newItem, stock: e.target.value })}
                    style={{ flex: 1, padding: 6, border: '1px solid #ccc', borderRadius: 4, boxSizing: 'border-box' }}
                  />
                </div>
                <input
                  type="number"
                  min={0}
                  placeholder="警戒值"
                  value={newItem.threshold}
                  onChange={(e) => setNewItem({ ...newItem, threshold: e.target.value })}
                  style={{ padding: 6, border: '1px solid #ccc', borderRadius: 4, boxSizing: 'border-box' }}
                />
                <button
                  onClick={handleAddNewItem}
                  style={{ background: '#27ae60', color: '#fff', border: 'none', padding: 7, width: '100%', borderRadius: 4, cursor: 'pointer', fontWeight: 700, fontSize: 13, marginTop: 3 }}
                >
                  新增並上架商品
                </button>
              </div>

              <h4 style={{ margin: '14px 0 5px', fontSize: 13, color: '#34495e' }}>📤 一鍵上傳（整批新商品）</h4>
              <p style={{ fontSize: 11, color: '#666', margin: '0 0 6px' }}>
                一次要上架很多個新{itemLabel}時用這個，不用一筆一筆手動填上面的表單。
              </p>
              <TemplateDownloadButton label={`下載${itemLabel}一鍵上傳範本`} onClick={handleDownloadUploadTemplate} />
              <ExcelUploadButton label={`一鍵上傳${itemLabel}`} onFile={handleBulkUploadFile} />
            </div>
          </details>

          <details style={{ marginBottom: 14, border: '1px solid #ddd', borderRadius: 5, padding: 10, background: '#fafafa' }}>
            <summary style={{ fontWeight: 700, cursor: 'pointer', color: '#2c3e50', fontSize: 14 }}>✏️ 品項名稱與價格/庫存設定</summary>
            <div style={{ maxHeight: 240, overflowY: 'auto', marginTop: 8 }}>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ padding: 4 }}>品項名稱</th>
                    <th style={{ padding: 4 }}>單價</th>
                    <th style={{ padding: 4 }}>庫存</th>
                    <th style={{ padding: 4 }}>警戒</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id}>
                      <td style={{ padding: 4 }}>
                        <input
                          defaultValue={i.name}
                          onBlur={(e) => e.target.value.trim() !== i.name && handleUpdateItem(i, { name: e.target.value })}
                          style={{ width: 90, padding: 3, fontSize: 12, border: '1px solid #ccc', borderRadius: 3 }}
                        />
                      </td>
                      <td style={{ padding: 4 }}>
                        <input
                          type="number"
                          min={0}
                          defaultValue={i.unit_price ?? 0}
                          onBlur={(e) => Number(e.target.value) !== (i.unit_price ?? 0) && handleUpdateItem(i, { unit_price: Number(e.target.value) })}
                          style={{ width: 55, padding: 3, fontSize: 12, border: '1px solid #ccc', borderRadius: 3, textAlign: 'center' }}
                        />
                      </td>
                      <td style={{ padding: 4, fontWeight: 700, color: i.quantity_on_hand <= i.low_stock_threshold ? 'red' : undefined }}>{i.quantity_on_hand}</td>
                      <td style={{ padding: 4 }}>
                        <input
                          type="number"
                          min={0}
                          defaultValue={i.low_stock_threshold}
                          onBlur={(e) => Number(e.target.value) !== i.low_stock_threshold && handleUpdateItem(i, { low_stock_threshold: Number(e.target.value) })}
                          style={{ width: 40, padding: 2, fontSize: 12, textAlign: 'center' }}
                        />
                      </td>
                      <td>
                        <button onClick={() => handleDeleteItem(i)} style={{ fontSize: 11, color: '#A32D2D', background: 'none', border: 'none', cursor: 'pointer' }}>
                          刪除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>

          <details style={{ marginBottom: 4, border: '1px solid #ddd', borderRadius: 5, padding: 10, background: '#fafafa' }}>
            <summary style={{ fontWeight: 700, cursor: 'pointer', color: '#2c3e50', fontSize: 14 }}>📜 歷史營運與交易紀錄</summary>
            <div style={{ maxHeight: 280, overflowY: 'auto', marginTop: 8 }}>
              <h4 style={{ margin: '5px 0', fontSize: 13, color: '#34495e' }}>📅 每日統計</h4>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', marginBottom: 15 }}>
                <thead>
                  <tr>
                    <th style={{ padding: 4 }}>日期</th>
                    <th style={{ padding: 4 }}>數量</th>
                    <th style={{ padding: 4 }}>金額</th>
                  </tr>
                </thead>
                <tbody>
                  {dailySummary.length === 0 ? (
                    <tr>
                      <td colSpan={3} style={{ color: '#888', padding: 4 }}>
                        尚無紀錄
                      </td>
                    </tr>
                  ) : (
                    dailySummary.map(([label, stats]) => (
                      <tr key={label}>
                        <td style={{ padding: 4 }}>{label}</td>
                        <td style={{ padding: 4, fontWeight: 700 }}>{stats.qty} 件</td>
                        <td style={{ padding: 4, color: stats.direction === '入庫' ? '#2980b9' : '#e67e22', fontWeight: 700 }}>${stats.amount}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>

              <h4 style={{ margin: '5px 0', fontSize: 13, color: '#34495e' }}>🕒 交易明細</h4>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ padding: 4 }}>時間</th>
                    <th style={{ padding: 4 }}>品項</th>
                    <th style={{ padding: 4 }}>數量</th>
                    <th style={{ padding: 4 }}>小計</th>
                  </tr>
                </thead>
                <tbody>
                  {txs.length === 0 ? (
                    <tr>
                      <td colSpan={4} style={{ color: '#888', padding: 4 }}>
                        尚無紀錄
                      </td>
                    </tr>
                  ) : (
                    txs.map((t) => {
                      const item = items.find((i) => i.id === t.item_id);
                      return (
                        <tr key={t.id}>
                          <td style={{ padding: 4 }}>{formatDateTime(new Date(t.recorded_at))}</td>
                          <td style={{ padding: 4, color: t.direction === '入庫' ? '#2980b9' : '#27ae60', fontWeight: 700 }}>
                            {t.note === '快速補貨' || t.note === '新商品初始庫存' ? `[${t.note}] ` : ''}
                            {item?.name ?? '（已刪除品項）'}
                          </td>
                          <td style={{ padding: 4 }}>{t.quantity}</td>
                          <td style={{ padding: 4 }}>${t.quantity * (t.unit_price_at_time ?? 0)}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </details>

          {perms.userId && (
            <>
              <MyPendingChangesList userId={perms.userId} tableName="general_inventory_items" />
              <MyPendingChangesList userId={perms.userId} tableName="general_inventory_transactions" />
            </>
          )}
        </div>
      )}
    </div>
  );
}
