'use client';
import SalesInventoryPage from '@/components/general-affairs/SalesInventoryPage';

export default function NotebooksPage() {
  return (
    <SalesInventoryPage
      category="簿本"
      title="簿本庫存販賣表"
      itemLabel="學用品"
      hint="販賣作業（出貨）／採購作業（進貨）／表格下載三分頁，右側「資訊側邊欄」可查庫存警示、快速補貨、新增商品、調整單價與警戒值、歷史紀錄。"
    />
  );
}
