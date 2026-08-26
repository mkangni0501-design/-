-- ============================================================
-- 42. 修正成績鎖定的權限規則（submission_windows RLS）
-- ------------------------------------------------------------
-- 回報問題：
--   1. 「管理者端的權限比教師端還小」——管理者(admin_a/admin_b)已經把期中/期末/平時
--      三項都設定鎖定，但排名/總成績還是沒出現；要導師改成鎖定「平時分」才出現。
--      且「期中、期末、平時共用一個鎖定鈕」。
--   2. 成績總表的總成績與排名沒出現。
--
-- 追查結果：這不是這次新增的「鎖定」按鈕本身寫錯，是 submission_windows 這張表的
-- RLS 政策，在更早的 sql/22department_policy_rewrite_complete.sql 被改壞了：
--
--   drop policy if exists admin_manage_submission_windows on submission_windows;
--   create policy department_manage_submission_windows on submission_windows
--     for all
--     using (
--       is_system_admin()                                        -- 只有 system_admin_s
--       or (data_type = '出缺勤' and has_department('discipline'))
--       or (data_type in ('期中考','期末考','平時分') and has_department('academic'))
--     )
--     ...
--
--   is_system_admin() 只認 role = 'system_admin_s'，不包含 admin_a、admin_b。
--   也就是說，sql/22 之後，admin_a／admin_b 除非「另外也被指派到教務處(academic)」，
--   否則完全沒有權限寫入 submission_windows——但 Supabase 的 RLS 對 UPDATE 是「條件
--   不符就影響 0 筆、不會噴錯誤」，所以管理者畫面上點「鎖定」看起來像是成功了
--   （沒有跳出錯誤訊息），實際上那筆設定完全沒有被改到，這就是「管理者已三項鎖定，
--   但沒出現成績排行」的真正原因；同時因為 homeroom_lock_own_class_daily_score
--   這個政策當初只開放「平時分」一種，才會變成「只有導師鎖平時分才真的鎖得動」，
--   看起來就像「期中/期末/平時共用一個鎖定鈕」——其實是另外兩種考試類型導師/一般
--   任課教師完全沒有任何管道能寫入。
--
-- 這裡的修正原則跟 sql/41score_entry_fixes.sql 的 can_write_score() 一致：
-- 系統管理員S、管理員A、管理員B（current_role_name() in admin_a/admin_b/system_admin_s）
-- 一律不受部門標籤限制，永遠可以管理；教務處主管（has_department('academic')／
-- 'discipline'）是「額外加開」的權限，不是取代管理者的唯一途徑。
-- 同時把導師可以鎖定的範圍從「只有平時分」擴大成「期中考／期末考／平時分」都可以
-- （各自獨立的一筆設定，不會互相影響），對應這次「成績登錄」頁新增的鎖定按鈕。
-- ============================================================

drop policy if exists department_manage_submission_windows on submission_windows;
drop policy if exists admin_manage_submission_windows on submission_windows;
create policy admin_manage_submission_windows on submission_windows
  for all
  using (
    current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
    or (data_type = '出缺勤' and has_department('discipline'))
    or (data_type in ('期中考', '期末考', '平時分') and has_department('academic'))
  )
  with check (
    current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
    or (data_type = '出缺勤' and has_department('discipline'))
    or (data_type in ('期中考', '期末考', '平時分') and has_department('academic'))
  );

drop policy if exists homeroom_lock_own_class_daily_score on submission_windows;
create policy homeroom_lock_own_class_scores on submission_windows
  for all
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
    and exists (
      select 1 from classes c
      where c.id::text = submission_windows.scope_ref
        and c.homeroom_teacher_id = current_teacher_id()
    )
  );

-- 附帶提醒：一般「任課教師」（不是導師、也不是管理員/教務主管）目前仍然無法鎖定，
-- 這是刻意保留的行為，不是漏洞——鎖定的效果是整個班「這個考試類型」的所有科目
-- 一起鎖住（見 ScoresEntryTab.tsx 鎖定按鈕前的確認訊息），不應該讓只教一科的
-- 任課老師單方面鎖住全班其他科目老師的輸入。畫面端已經對應調整：只有
-- 導師本人／管理員S、A、B／教務處主管，才會在「成績登錄」頁看到「鎖定」按鈕
-- （其他任課教師看得到「儲存」，但看不到「鎖定」）。
