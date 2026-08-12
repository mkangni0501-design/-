import { useState } from 'react';

/**
 * 管理一份列表的「勾選」狀態，checkbox 支援 shift+點選做範圍連續勾選
 * （跟 Excel／檔案總管一樣：先點第一筆，按住 shift 點最後一筆，中間全部一起勾選/取消）。
 *
 * 用法：
 *   const { selected, setSelected, handleRowClick, toggleSelectAll } = useShiftSelect(rows, (r) => r.id);
 *   <input type="checkbox" checked={selected.has(r.id)}
 *     onClick={(e) => { e.preventDefault(); handleRowClick(index, e.shiftKey); }}
 *     onChange={() => {}} />
 */
export function useShiftSelect<T>(rows: T[], getId: (row: T) => string) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastIndex, setLastIndex] = useState<number | null>(null);

  function handleRowClick(index: number, shiftKey: boolean) {
    if (index < 0 || index >= rows.length) return;
    const id = getId(rows[index]);
    setSelected((prev) => {
      const next = new Set(prev);
      if (shiftKey && lastIndex !== null) {
        const start = Math.min(lastIndex, index);
        const end = Math.max(lastIndex, index);
        // 用這一筆原本有沒有被勾選，決定整段範圍是要「全部勾上」還是「全部取消」
        const shouldSelect = !next.has(id);
        for (let i = start; i <= end; i++) {
          const rid = getId(rows[i]);
          if (shouldSelect) next.add(rid);
          else next.delete(rid);
        }
      } else {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      }
      return next;
    });
    setLastIndex(index);
  }

  function toggleSelectAll(idsOverride?: string[]) {
    const ids = idsOverride ?? rows.map(getId);
    setSelected((prev) => {
      const allSelected = ids.length > 0 && ids.every((id) => prev.has(id));
      return allSelected ? new Set() : new Set(ids);
    });
  }

  return { selected, setSelected, handleRowClick, toggleSelectAll, lastIndex };
}
