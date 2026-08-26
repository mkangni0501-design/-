-- ============================================================
-- 41. 成績登錄頁／科目與比重設定 修正
-- ------------------------------------------------------------
-- 對應這一輪反映的問題：
--   1b. 鎖定要能在「成績登錄」頁針對目前這個班＋這個考試類型單獨鎖定（不是只有導師在
--       「班級成績總表」頁能鎖「平時分」）；期中/期末/平時三者本來就各自一筆
--       submission_windows（sql/34 已修正過鎖定範圍的 fallback），這裡只需要補上
--       「教務處主管」也能比照系統管理員S、管理員A直接寫入不受科目限制。
--   1e. 期中/期末/平時 三個「各科總分」原本只是單純加總原始分數，沒有乘上
--       curriculum 的科目比重、也沒有平均。這裡改成：
--         - {examtype}_total 改成「各科分數 × 該科比重」加總（比照總表的計算邏輯，
--           只是不再乘上 grading_rules 的期中/期末/平時整體佔比）
--         - 新增 {examtype}_average：該次考試「有登錄成績的科目」原始分數平均，
--           讓老師能一眼看出這次考試的平均表現，跟「乘比重後的總分」分開看
--       同時比照第 3 點，比重=0 的科目不計入。
--   1f. score_audit_log 這張表從 sql/1schema.sql 建立以來，从来沒有任何程式或
--       trigger 真的寫入過（只有 UI 的唯讀查詢畫面），等於「鎖定又解開後教師修改的
--       內容」完全沒有留下紀錄。這裡補上 trigger，比照 sql/40 對 attendance 的做法，
--       在資料庫層級補齊，不會因為前端漏寫某個管道而少記。
--   3.  比重=0 的科目，成績登錄的科目下拉、成績單都不應該出現——這裡在資料庫端
--       也把 student_examtype_totals／student_base_scores 一併排除（後者本來就已經
--       用 inner join curriculum，會自動排除沒有對應 curriculum 列的科目；weight=0
--       的列本來就存在於 curriculum，所以要另外用 where cu.weight > 0 排除）。
--
-- 需在 sql/ 資料夾其餘 40 個檔案都執行過後再執行本檔。
-- ============================================================

-- ---------- 1b. 教務處主管：比照系統管理員S/A/B，寫入成績不受「自己教的科目」限制 ----------
-- 沿用 sql/15scores_write_permission_fix.sql 的 can_write_score()，只加一段
-- is_department_lead('academic') 的判斷，其餘規則（一般教師只能寫自己教的科目、
-- 鎖定後需核准修正申請）維持不變。
create or replace function can_write_score(p_enrollment_id uuid, p_subject text, p_exam_type text, p_score_id uuid default null)
returns boolean as $$
declare
  v_class_id uuid;
  v_academic_year int;
  v_term text;
  v_is_owner boolean;
begin
  select c.id, c.academic_year, e.term into v_class_id, v_academic_year, v_term
  from enrollments e join classes c on c.id = e.class_id
  where e.id = p_enrollment_id;

  if current_role_name() in ('admin_a', 'admin_b', 'system_admin_s') then
    return true; -- 管理員不受鎖定限制，負責審核與最終處理
  end if;

  if is_department_lead('academic') then
    return true; -- 教務處主管：比照管理員，可以直接寫入任何科目，不受「自己教的科目」限制
  end if;

  -- 只認「任課教師設定」裡實際指派的班級＋科目，不再因為「是這班導師」就自動放行所有科目。
  v_is_owner := exists (
    select 1 from class_schedule cs
    where cs.class_id = v_class_id and cs.teacher_id = current_teacher_id() and cs.subject = p_subject
  );

  if not v_is_owner then
    return false;
  end if;

  if not scores_locked(v_class_id, v_academic_year, v_term, p_exam_type) then
    return true;
  end if;

  -- 鎖定後：導師與任課教師都必須有核准的修正申請才能再寫
  return p_score_id is not null and has_approved_correction(p_score_id);
end;
$$ language plpgsql stable security definer;

-- ---------- 1e. + 3. 各次考試「各科總分」改成乘上比重，並新增「平均」，排除比重=0的科目 ----------
create or replace view student_examtype_totals
with (security_invoker = true)
as
select
  ss.enrollment_id,
  sum(ss.midterm * cu.weight) filter (where ss.midterm is not null) as midterm_total,
  sum(ss.final * cu.weight) filter (where ss.final is not null) as final_total,
  sum(ss.daily * cu.weight) filter (where ss.daily is not null) as daily_total,
  round(avg(ss.midterm) filter (where ss.midterm is not null), 2) as midterm_average,
  round(avg(ss.final) filter (where ss.final is not null), 2) as final_average,
  round(avg(ss.daily) filter (where ss.daily is not null), 2) as daily_average
from subject_scores ss
join enrollments e on e.id = ss.enrollment_id
join classes c on c.id = e.class_id
join curriculum cu
  on cu.academic_year = c.academic_year
  and cu.term = e.term
  and cu.grade_level = c.grade_level
  and cu.subject = ss.subject
where cu.weight > 0
group by ss.enrollment_id;

-- class_rankings / grade_rankings 兩個 view 都是用 select * 疊 case when 蓋在上面
-- （sql/21ranking_lock_granularity_fix.sql 的版本），本身沒有明列 student_examtype_totals
-- 的欄位清單，所以 midterm_total/final_total/daily_total 會自動套用新的「乘比重」算法；
-- 但兩個 view 目前沒有把新增的 *_average 往外帶出，這裡照同一套「依鎖定狀態決定要不要
-- 顯示」的邏輯，重新建一次、在最後補上三個 average 欄位（append 在最後、不動原本欄位順序，
-- 避免影響任何既有查詢用到的欄位位置）。

drop view if exists class_rankings cascade;
create or replace view class_rankings
with (security_invoker = true)
as
select
  ranked.enrollment_id,
  ranked.class_id,
  ranked.term,
  ranked.academic_year,
  ranked.name,
  ranked.seat_no,
  ranked.student_no,

  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期中考')
        and exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期末考')
        and exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '平時分')
       then ranked.total_score end as total_score,
  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期中考')
        and exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期末考')
        and exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '平時分')
       then ranked.class_rank end as class_rank,

  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期中考')
       then ranked.midterm_total end as midterm_total,
  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期中考')
       then ranked.midterm_class_rank end as midterm_class_rank,

  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期末考')
       then ranked.final_total end as final_total,
  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期末考')
       then ranked.final_class_rank end as final_class_rank,

  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '平時分')
       then ranked.daily_total end as daily_total,
  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '平時分')
       then ranked.daily_class_rank end as daily_class_rank,

  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期中考')
       then ranked.midterm_average end as midterm_average,
  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期末考')
       then ranked.final_average end as final_average,
  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '平時分')
       then ranked.daily_average end as daily_average

from (
  select
    t.enrollment_id, e.class_id, e.term, c.academic_year, st.name, e.seat_no, e.student_no,
    t.total_score,
    rank() over (partition by e.class_id, e.term order by t.total_score desc) as class_rank,
    et.midterm_total,
    rank() over (partition by e.class_id, e.term order by et.midterm_total desc) as midterm_class_rank,
    et.final_total,
    rank() over (partition by e.class_id, e.term order by et.final_total desc) as final_class_rank,
    et.daily_total,
    rank() over (partition by e.class_id, e.term order by et.daily_total desc) as daily_class_rank,
    et.midterm_average,
    et.final_average,
    et.daily_average
  from student_total_scores t
  join enrollments e on e.id = t.enrollment_id
  join classes c on c.id = e.class_id
  join students st on st.student_no = e.student_no
  left join student_examtype_totals et on et.enrollment_id = t.enrollment_id
) ranked
where (
  current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
  or exists (select 1 from classes c2 where c2.id = ranked.class_id and c2.homeroom_teacher_id = current_teacher_id())
  or is_linked_parent(ranked.student_no)
);

drop view if exists grade_rankings cascade;
create or replace view grade_rankings
with (security_invoker = true)
as
select
  ranked.enrollment_id,
  ranked.class_id,
  ranked.term,
  ranked.academic_year,
  ranked.department,
  ranked.grade_level,
  ranked.name,
  ranked.seat_no,
  ranked.student_no,

  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期中考')
        and exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期末考')
        and exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '平時分')
       then ranked.total_score end as total_score,
  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期中考')
        and exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期末考')
        and exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '平時分')
       then ranked.grade_rank end as grade_rank,

  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期中考')
       then ranked.midterm_total end as midterm_total,
  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期中考')
       then ranked.midterm_grade_rank end as midterm_grade_rank,

  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期末考')
       then ranked.final_total end as final_total,
  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期末考')
       then ranked.final_grade_rank end as final_grade_rank,

  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '平時分')
       then ranked.daily_total end as daily_total,
  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '平時分')
       then ranked.daily_grade_rank end as daily_grade_rank,

  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期中考')
       then ranked.midterm_average end as midterm_average,
  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期末考')
       then ranked.final_average end as final_average,
  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '平時分')
       then ranked.daily_average end as daily_average

from (
  select
    t.enrollment_id, e.class_id, e.term, c.academic_year, c.department, c.grade_level,
    st.name, e.seat_no, e.student_no,
    t.total_score,
    rank() over (partition by c.academic_year, e.term, c.department, c.grade_level order by t.total_score desc) as grade_rank,
    et.midterm_total,
    rank() over (partition by c.academic_year, e.term, c.department, c.grade_level order by et.midterm_total desc) as midterm_grade_rank,
    et.final_total,
    rank() over (partition by c.academic_year, e.term, c.department, c.grade_level order by et.final_total desc) as final_grade_rank,
    et.daily_total,
    rank() over (partition by c.academic_year, e.term, c.department, c.grade_level order by et.daily_total desc) as daily_grade_rank,
    et.midterm_average,
    et.final_average,
    et.daily_average
  from student_total_scores t
  join enrollments e on e.id = t.enrollment_id
  join classes c on c.id = e.class_id
  join students st on st.student_no = e.student_no
  left join student_examtype_totals et on et.enrollment_id = t.enrollment_id
) ranked
where (
  current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
  or exists (select 1 from classes c2 where c2.id = ranked.class_id and c2.homeroom_teacher_id = current_teacher_id())
  or is_linked_parent(ranked.student_no)
);

-- ---------- 1f. 成績修改留下紀錄，僅系統管理員S、管理員A看得到 ----------
-- 比照 sql/40 對 attendance 的做法：不管是哪個畫面／哪個管道寫入 scores，
-- 一律在資料庫層級的 trigger 補上紀錄，不會因為前端漏寫某個管道而少記。
-- INSERT／UPDATE（分數變更）／DELETE（批次清除分數）都記一筆；
-- UPDATE 時如果分數沒有實際變化（例如同分覆蓋）就不記，避免灌水。
create or replace function log_score_change() returns trigger
security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into score_audit_log (score_id, changed_by, old_value, new_value)
    values (new.id, current_teacher_id(), null, new.score::text);
  elsif tg_op = 'UPDATE' then
    if old.score is distinct from new.score then
      insert into score_audit_log (score_id, changed_by, old_value, new_value)
      values (new.id, current_teacher_id(), old.score::text, new.score::text);
    end if;
  elsif tg_op = 'DELETE' then
    insert into score_audit_log (score_id, changed_by, old_value, new_value)
    values (old.id, current_teacher_id(), old.score::text, null);
  end if;
  return coalesce(new, old);
end;
$$ language plpgsql;

drop trigger if exists trg_log_score_change on scores;
create trigger trg_log_score_change
  after insert or update or delete on scores
  for each row execute function log_score_change();

-- 附帶提醒：score_audit_log.score_id 原本是 `references scores(id)`（非 on delete cascade），
-- 刪除分數時這個 trigger 會先插入稽核紀錄、scores 那筆才真正被刪掉，沒有先後順序問題；
-- 但刪除之後 score_id 這個外鍵會變成「指向一筆已經不存在的 scores 資料」，之後如果需要
-- 對照被刪除是哪一科/哪個學生，請改用 changed_at 時間 + old_value/new_value 判斷
-- （既有的 attendance_audit_log 對「已刪除的出缺勤紀錄」也是同樣的限制，非本次新增的問題）。

-- ---------- 附帶：is_admin_sa() 稽核紀錄查詢權限，score_audit_log 沿用 sql/40 已經設定好的
-- admin_only_read_score_audit（限 system_admin_s／admin_a），這裡不用重複設定。
