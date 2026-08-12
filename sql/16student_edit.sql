-- ============================================================
-- 「查詢學生」頁的「修正學生資料」功能需要的資料庫異動
-- 請在 schema.sql、policies.sql、registration.sql、portal.sql 都執行過之後再執行本檔
-- ============================================================

-- ---------- 修改紀錄：記錄最後一次是誰、什麼時候改的 ----------
alter table students add column if not exists updated_at timestamptz;
alter table students add column if not exists updated_by uuid references app_users(id);

-- ---------- 開放班導師可以直接修正「自己現任班級」學生的基本資料 ----------
-- portal.sql 原本的設計是：導師不能直接改，要走「家長/學生提出申請→導師或管理員審核」的流程。
-- 這裡依需求新增一條政策，讓導師也能像管理員一樣直接修正——這條政策是「疊加」上去的，
-- 不會動到 portal.sql 已經建立的 admin_update_students，管理員能改的範圍不受影響。
-- 只限「目前現行班級」（enrollments.is_current = true）是這位導師帶的班，且只限本人是該生導師時才能改。
create policy homeroom_update_own_class_students on students
  for update
  using (
    exists (
      select 1 from enrollments e
      join classes c on c.id = e.class_id
      where e.student_no = students.student_no
        and e.is_current = true
        and c.homeroom_teacher_id = current_teacher_id()
    )
  )
  with check (
    exists (
      select 1 from enrollments e
      join classes c on c.id = e.class_id
      where e.student_no = students.student_no
        and e.is_current = true
        and c.homeroom_teacher_id = current_teacher_id()
    )
  );
