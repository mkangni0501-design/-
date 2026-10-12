-- ============================================================
-- 103. 殘留科目清理：成績表裡有分數，但「科目與比重設定」(curriculum) 已經沒有的科目
-- ------------------------------------------------------------
-- 問題：誤植或遺留的科目（例如某班多出來的科目）會出現在「班級成績總表」的欄位，
--       但「學生成績登錄」的科目下拉只列排課科目＋curriculum 的科目，
--       「科目與比重設定」裡也沒有這一列 → 沒有任何地方可以修正或刪除。
-- 做法：提供三個函式（security invoker，沿用 scores 原本的 RLS：只有系統管理員／
--       教務可以刪改；刪除/改分數仍會經過 sql/41 的 trg_log_score_change 稽核）：
--   orphan_score_subjects()        列出殘留科目（逐班）
--   delete_orphan_score_subject()  刪除某殘留科目的成績（可限定單一班級）
--   move_orphan_score_subject()    把殘留科目的成績「改掛」到正確科目（可限定單一班級）
-- 安全條件：只處理「該學年度＋學期＋年級已經有設定過 curriculum」且「科目不在其中」的成績；
--           完全沒設定過 curriculum 的舊學期不會被當成殘留；「全勤」「出缺席」不處理。
-- 可重複執行。
-- ============================================================

create or replace function orphan_score_subjects(p_academic_year int default null, p_term text default null)
returns table (
  class_id uuid, class_label text, academic_year int, term text, grade_level text,
  subject text, score_count bigint, student_count bigint
)
language sql stable
security invoker
set search_path = public
as $$
  select c.id, c.grade_level || c.class_name, c.academic_year, e.term, c.grade_level,
         s.subject, count(*), count(distinct e.id)
  from scores s
  join enrollments e on e.id = s.enrollment_id
  join classes c on c.id = e.class_id
  where (p_academic_year is null or c.academic_year = p_academic_year)
    and (p_term is null or e.term = p_term)
    and s.subject not in ('全勤', '出缺席')
    and exists (
      select 1 from curriculum k
      where k.academic_year = c.academic_year and k.term = e.term and k.grade_level = c.grade_level
    )
    and not exists (
      select 1 from curriculum k
      where k.academic_year = c.academic_year and k.term = e.term and k.grade_level = c.grade_level
        and k.subject = s.subject
    )
  group by c.id, c.grade_level, c.class_name, c.academic_year, e.term, s.subject
  order by c.academic_year desc, e.term, c.grade_level, c.class_name, s.subject;
$$;

create or replace function delete_orphan_score_subject(
  p_academic_year int, p_term text, p_grade_level text, p_subject text, p_class_id uuid default null
) returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare v_count integer;
begin
  if p_subject in ('全勤', '出缺席') then
    return 0;
  end if;
  with del as (
    delete from scores s
    using enrollments e, classes c
    where e.id = s.enrollment_id and c.id = e.class_id
      and c.academic_year = p_academic_year and e.term = p_term and c.grade_level = p_grade_level
      and s.subject = p_subject
      and (p_class_id is null or c.id = p_class_id)
      and exists (
        select 1 from curriculum k
        where k.academic_year = c.academic_year and k.term = e.term and k.grade_level = c.grade_level
      )
      and not exists (
        select 1 from curriculum k
        where k.academic_year = c.academic_year and k.term = e.term and k.grade_level = c.grade_level
          and k.subject = s.subject
      )
    returning 1
  )
  select count(*) into v_count from del;
  return v_count;
end;
$$;

create or replace function move_orphan_score_subject(
  p_academic_year int, p_term text, p_grade_level text, p_old_subject text, p_new_subject text,
  p_class_id uuid default null
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare v_moved integer; v_left integer;
begin
  if p_old_subject in ('全勤', '出缺席') or p_new_subject in ('全勤', '出缺席') then
    raise exception '全勤／出缺席是系統自動計算的科目，不能用這個功能搬移';
  end if;
  if not exists (
    select 1 from curriculum k
    where k.academic_year = p_academic_year and k.term = p_term
      and k.grade_level = p_grade_level and k.subject = p_new_subject
  ) then
    raise exception '目標科目「%」不在 % 學年度%【%】的科目與比重設定裡', p_new_subject, p_academic_year, p_term, p_grade_level;
  end if;

  with moved as (
    update scores s set subject = p_new_subject
    from enrollments e, classes c
    where e.id = s.enrollment_id and c.id = e.class_id
      and c.academic_year = p_academic_year and e.term = p_term and c.grade_level = p_grade_level
      and s.subject = p_old_subject
      and (p_class_id is null or c.id = p_class_id)
      and not exists (
        select 1 from curriculum k
        where k.academic_year = c.academic_year and k.term = e.term and k.grade_level = c.grade_level
          and k.subject = s.subject
      )
      -- 該學生同一種考試在目標科目已經有分數 → 不覆蓋（留在殘留清單，由人決定要不要刪）
      and not exists (
        select 1 from scores s2
        where s2.enrollment_id = s.enrollment_id and s2.exam_type = s.exam_type and s2.subject = p_new_subject
      )
    returning 1
  )
  select count(*) into v_moved from moved;

  select count(*) into v_left
  from scores s
  join enrollments e on e.id = s.enrollment_id
  join classes c on c.id = e.class_id
  where c.academic_year = p_academic_year and e.term = p_term and c.grade_level = p_grade_level
    and s.subject = p_old_subject and (p_class_id is null or c.id = p_class_id);

  return jsonb_build_object('moved', v_moved, 'skipped', v_left);
end;
$$;

notify pgrst, 'reload schema';
