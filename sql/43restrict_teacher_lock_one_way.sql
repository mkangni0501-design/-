-- ============================================================
-- 43. 教師（含導師）的鎖定權限必須比管理者小：只能「鎖」，不能「解鎖」
-- ------------------------------------------------------------
-- 回報問題（延續 sql/42）：
--   c. 教師(含班級導師)的鎖定功能必須比管理者小(當超過管理者設定時間或者管理者鎖定後,
--      教師鎖定功能即失效)，且平時、期中、期末三表要分開鎖定。
--
-- 分開鎖定的部分 sql/42 已經處理（homeroom_lock_own_class_scores 已經涵蓋
-- 期中考／期末考／平時分三種，各自獨立一筆設定）。但重新檢查 sql/42 寫的
-- homeroom_lock_own_class_scores 政策用的是 `for all`，這其實比原本文件上寫的
-- 「鎖定後,任何人(含你自己)都無法直接修改,需經管理員審核才能再調整」還寬鬆：
--
--   `for all` 包含 SELECT／INSERT／UPDATE／DELETE，且 WITH CHECK 完全沒有限制
--   is_locked 這個欄位的值——也就是說，導師理論上可以直接呼叫
--   `.update({is_locked:false})`（即使目前的畫面沒有提供這個按鈕，用瀏覽器 console
--   或未來不小心新增的功能都做得到），或甚至直接把這筆設定整列刪除（DELETE 只看
--   USING，沒有 WITH CHECK 可以擋），兩種方式都能讓自己班「回到未鎖定」，等於
--   導師的鎖定權限其實跟管理者一樣大（都能鎖也都能解鎖），沒有比管理者小。
--
-- 這裡把 homeroom 的政策拆成「只能新增／更新成『已鎖定』，不能新增／更新成『未鎖定』，
-- 也不能刪除」，管理者才是唯一能把已鎖定的設定重新打開的角色（透過
-- score-submission-windows 頁的「解鎖」按鈕 → reopen_submission_window()，這支函式
-- 是 security invoker，一樣受這裡的 RLS 規範，導師呼叫一樣會被擋下）。
-- ============================================================

drop policy if exists homeroom_lock_own_class_scores on submission_windows;

-- 導師新增自己班級的鎖定設定：只能新增成 is_locked = true
create policy homeroom_insert_own_class_lock on submission_windows
  for insert
  with check (
    scope = '班級'
    and data_type in ('期中考', '期末考', '平時分')
    and is_locked = true
    and exists (
      select 1 from classes c
      where c.id::text = submission_windows.scope_ref
        and c.homeroom_teacher_id = current_teacher_id()
    )
  );

-- 導師更新自己班級「已存在」的設定：新的值也必須還是 is_locked = true——
-- 也就是只能重複確認鎖定（等於沒有變化），不能把已鎖定的改回未鎖定。
-- 管理者要重新打開，走 score-submission-windows 頁的「解鎖」（admin_manage_submission_windows
-- 政策底下才能把 is_locked 改回 false），不是這條給導師用的政策。
create policy homeroom_update_own_class_lock on submission_windows
  for update
  using (
    scope = '班級'
    and data_type in ('期中考', '期末考', '平時分')
    and exists (
      select 1 from classes c
      where c.id::text = submission_windows.scope_ref
        and c.homeroom_teacher_id = current_teacher_id()
    )
  )
  with check (
    scope = '班級'
    and data_type in ('期中考', '期末考', '平時分')
    and is_locked = true
    and exists (
      select 1 from classes c
      where c.id::text = submission_windows.scope_ref
        and c.homeroom_teacher_id = current_teacher_id()
    )
  );

-- 導師沒有 DELETE 權限（沒有幫他們建對應的 delete policy）：預設就是禁止，
-- 不需要另外寫一條「拒絕」的政策——RLS 沒有符合的政策就是不允許。

-- 附帶說明「超過管理者設定時間或者管理者鎖定後,教師鎖定功能即失效」這句：
-- ClassSummaryTab.tsx／ScoresEntryTab.tsx 的鎖定按鈕現在都是用 submission_window_locked()
-- 這支函式（班級 > 部別 > 全校 fallback、且會看 closes_at 是否已過期）判斷要不要顯示，
-- 不是只看「這個班自己有沒有設定」。所以只要管理者在部別/全校層級鎖定、或設定的開放
-- 結束時間已經過了，這裡就會自動判定為「已鎖定」，導師畫面上的鎖定按鈕會自動消失、
-- 改顯示「✓ 已鎖定」，不需要額外的程式碼處理——這部分已經在 sql/42 之後、這次的
-- ClassSummaryTab.tsx／ScoresEntryTab.tsx 修改裡完成。
