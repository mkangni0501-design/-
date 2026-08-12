'use client';
import InventoryAdminPage from '@/components/general-affairs/InventoryAdminPage';

export default function LibraryPage() {
  return (
    <InventoryAdminPage
      category="書庫"
      title="書庫登記表"
      hint="登記圖書館藏書與借閱/歸還紀錄。「單價」欄位可留空（藏書通常不計價），庫存數量代表目前在館可借的冊數。"
    />
  );
}
