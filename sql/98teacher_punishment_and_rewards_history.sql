-- ============================================================
-- 98. 教師「懲處」規則比照「敘獎」（分層審核）；conduct_events 補 count 欄位，
--     供「查看獎懲」頁顯示次數
-- ------------------------------------------------------------
-- 反映事項：「增加查看獎懲頁面...另外補上教師『懲處』的規則（比照『敘獎』）」。
--
-- 上一輪（sql/95）「嘉獎/小功/大功」分層審核（B→A→S）只開放事件類別是這三種
-- 敘獎；懲處（警告/小過/大過）維持「只有訓導部門/系統管理員S可以直接登記」，
-- 其他教師完全不能登記懲處。這一輪把同一套分層審核擴大到懲處，讓其他教師也能
-- 針對自己有教過的班級提出懲處申請——分層規則跟敘獎的「輕重對應審核關卡數」
-- 完全比照：
--   嘉獎／警告　（最輕）→ 只需要管理員B
--   小功／小過　（中等）→ 管理員B → 管理員A
--   大功／大過　（最重）→ 管理員B → 管理員A → 管理員S
-- 訓導部門／系統管理員S 自己登記懲處，維持原本「直接登記、不用審核」的規則，
-- 這輪沒有變動。
-- ============================================================

alter table conduct_event_requests drop constraint if exists conduct_event_requests_event_type_check;
alter table conduct_event_requests add constraint conduct_event_requests_event_type_check
  check (event_type in ('嘉獎', '小功', '大功', '警告', '小過', '大過'));

-- 【本輪新增】conduct_events 補一個 count 欄位（預設 1，相容既有資料/既有直接
-- 登記的路徑）——「查看獎懲」頁要顯示「次數」，敘獎/懲處申請通過審核後，count
-- 要原封不動帶進 conduct_events，不能只留在 conduct_event_requests 裡（那張表
-- 一般教師/家長/學生都看不到，見下面 read_conduct_events_for_history 政策）。
alter table conduct_events add column if not exists count int not null default 1;

-- decide_conduct_event_request()：把原本「event_type = '嘉獎' 才停在B、
-- event_type = '大功' 才送S」這種寫死單一類別的判斷，改成用「輕重分級」
-- （tier）判斷，敘獎、懲處各三個等級的規則结構完全一樣，用同一份邏輯處理。
-- 同時把 count 一併帶進最後寫入 conduct_events 那一步。
create or replace function decide_conduct_event_request(p_id uuid, p_decision text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row conduct_event_requests;
  v_role user_role := current_role_name();
  v_uid uuid := auth.uid();
  v_new_id uuid;
  v_tier int; -- 1=只需B；2=B再送A；3=B→A再送S。嘉獎/警告=1，小功/小過=2，大功/大過=3
begin
  if p_decision not in ('同意', '不同意') then
    raise exception '決定只能是「同意」或「不同意」';
  end if;

  select * into v_row from conduct_event_requests where id = p_id for update;
  if v_row is null then
    raise exception '找不到這筆申請';
  end if;

  v_tier := case v_row.event_type
    when '嘉獎' then 1 when '警告' then 1
    when '小功' then 2 when '小過' then 2
    when '大功' then 3 when '大過' then 3
    else 1
  end;

  if v_row.status = '待B審核' then
    if v_role <> 'admin_b' then
      raise exception '目前這筆申請輪到管理員B審核，您沒有權限審核';
    end if;
    update conduct_event_requests set
      b_decision = p_decision, b_by = v_uid, b_at = now(),
      status = case
        when p_decision = '不同意' then '已駁回'
        when v_tier = 1 then '已核准'
        else '待A審核'
      end
    where id = p_id;

  elsif v_row.status = '待A審核' then
    if v_role <> 'admin_a' then
      raise exception '目前這筆申請輪到管理員A審核，您沒有權限審核';
    end if;
    update conduct_event_requests set
      a_decision = p_decision, a_by = v_uid, a_at = now(),
      status = case
        when p_decision = '不同意' then '已駁回'
        when v_tier = 3 then '待S審核'
        else '已核准'
      end
    where id = p_id;

  elsif v_row.status = '待S審核' then
    if v_role <> 'system_admin_s' then
      raise exception '目前這筆申請輪到管理員S審核，您沒有權限審核';
    end if;
    update conduct_event_requests set
      s_decision = p_decision, s_by = v_uid, s_at = now(),
      status = case when p_decision = '不同意' then '已駁回' else '已核准' end
    where id = p_id;

  else
    raise exception '這筆申請已經處理完成（%），不能重複審核', v_row.status;
  end if;

  select * into v_row from conduct_event_requests where id = p_id;
  if v_row.status = '已核准' and v_row.applied_at is null then
    insert into conduct_events (student_no, event_date, event_type, points, count, reason, recorded_by)
    values (
      v_row.student_no, v_row.event_date, v_row.event_type, v_row.points, v_row.count, v_row.reason,
      (select id from teachers where app_user_id = v_row.requested_by)
    )
    on conflict on constraint conduct_events_student_date_type_key
    do update set points = excluded.points, count = excluded.count, reason = excluded.reason, recorded_by = excluded.recorded_by
    returning id into v_new_id;
    update conduct_event_requests set applied_at = now(), conduct_event_id = v_new_id where id = p_id;
  end if;
end;
$$;

-- 【本輪新增】「查看獎懲」頁的讀取權限——內容是已經生效（已經寫進 conduct_events）
-- 的獎懲，不是審核中的申請（審核中的申請看 conduct_event_requests，走 sql/95
-- 那邊已有的 read_conduct_event_request 政策）：
--   - 訓導部門／系統管理員S／導師本人／曾經登記過的教師本人：可以看到跟自己
--     有關的（導師：本班學生 或 自己登記過的；一般教師：自己登記過的）。
--   - 家長／學生：只能看到自己（用 is_linked_parent／學生自己的 portal 帳號）。
-- 這裡先開放「訓導部門／系統管理員S 全校都看得到」＋「recorded_by 是自己」＋
-- 「導師本班學生」＋「家長/學生看自己」，涵蓋畫面上四種身分的需求；權限判斷
-- 集中在資料庫這一層，前端只是照身分分別下不同的查詢條件（見「查看獎懲」頁）。
drop policy if exists read_conduct_events_for_history on conduct_events;
create policy read_conduct_events_for_history on conduct_events
  for select
  using (
    is_system_admin()
    or has_department('discipline')
    or recorded_by = (select current_teacher_id())
    or exists (
      select 1 from enrollments e
      join classes c on c.id = e.class_id
      where e.student_no = conduct_events.student_no
        and c.homeroom_teacher_id = (select current_teacher_id())
    )
    or is_linked_parent(student_no) -- 涵蓋家長跟學生本人兩種 portal 帳號，見 sql/6portal.sql 的定義
  );

notify pgrst, 'reload schema';
