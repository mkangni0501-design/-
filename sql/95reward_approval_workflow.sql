-- ============================================================
-- 95. 敘獎（嘉獎／小功／大功）改成分層審核：管理員B→（小功再送）管理員A→
--     （大功再送）管理員S，全部核准後才真的寫進學生的獎懲紀錄
-- ------------------------------------------------------------
-- 反映事項：「按下『批次登記』後資料傳送通知到管理員B（訓導管理）。如有小功則
-- 管理員B批示後傳送到管理員A；如有大功則管理員A批示後到管理員S。都通過後才
-- 記錄到學生資料。各管理員在學生名單前勾選同意/不同意即可送出（有全選功能）」。
--
-- sql/93conduct_events_rewards_entry.sql（上一輪）是「送出就直接寫進
-- conduct_events」，訓導/管理員直接寫、教師受資料庫觸發器限制只能寫嘉獎/小功、
-- 單筆上限1小功。這一輪改成「送出」只是建立一筆待審核申請，要走完對應的審核
-- 關卡、每一關都「同意」，才會由審核函式真的寫進 conduct_events；只要任何一關
-- 「不同意」，就整筆變成「已駁回」，不會有任何資料寫進學生的正式獎懲紀錄。
--
-- 只有「敘獎」（嘉獎/小功/大功）走這套新流程；「懲處」（警告/小過/大過）沒有
-- 在這次反映事項裡提到分層審核，維持上一輪的規則：訓導部門/系統管理員S 直接
-- 登記，其他教師本來就不能登記懲處，這裡不動。
-- ============================================================

create table if not exists conduct_event_requests (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,              -- 同一次「批次登記」送出的這些列，共用一個 batch_id，方便畫面上顯示「同一批」
  student_no text not null references students(student_no),
  event_date date not null,
  event_type text not null check (event_type in ('嘉獎', '小功', '大功')),
  count int not null check (count between 1 and 5),
  points int not null,                 -- 依 conduct_point_defaults 的單次點數 × count 算出來，核准後原封不動寫進 conduct_events.points
  reason text not null,
  requested_by uuid not null references app_users(id),
  requested_at timestamptz not null default now(),
  status text not null default '待B審核'
    check (status in ('待B審核', '待A審核', '待S審核', '已核准', '已駁回')),
  b_decision text check (b_decision in ('同意', '不同意')),
  b_by uuid references app_users(id),
  b_at timestamptz,
  a_decision text check (a_decision in ('同意', '不同意')),
  a_by uuid references app_users(id),
  a_at timestamptz,
  s_decision text check (s_decision in ('同意', '不同意')),
  s_by uuid references app_users(id),
  s_at timestamptz,
  applied_at timestamptz,              -- 全部核准、真的寫進 conduct_events 完成的時間
  conduct_event_id uuid references conduct_events(id)
);

create index if not exists idx_conduct_event_requests_status on conduct_event_requests (status);
create index if not exists idx_conduct_event_requests_requested_by on conduct_event_requests (requested_by);
create index if not exists idx_conduct_event_requests_batch on conduct_event_requests (batch_id);

alter table conduct_event_requests enable row level security;

-- 建立申請：登入者只能以自己的身分送出（requested_by = 自己），且跟 sql/93 的
-- teacher_insert_conduct_events 一樣的資格限制——訓導部門/系統管理員S 不限學生，
-- 其他教師只能對自己有教過的班級的學生送出申請。
create policy create_own_conduct_event_request on conduct_event_requests
  for insert
  with check (
    requested_by = auth.uid()
    and (is_system_admin() or has_department('discipline') or teacher_teaches_student(student_no))
  );

-- 讀取：自己送出的申請一定看得到；管理員A/B/系統管理員S（審核鏈上的三個角色）
-- 看得到全部申請，才能在自己的審核清單裡看到別人送出的申請、也能回頭查已核准/
-- 已駁回的歷史紀錄。
create policy read_conduct_event_request on conduct_event_requests
  for select
  using (
    requested_by = auth.uid()
    or current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
  );

-- 審核（同意/不同意）一律透過 decide_conduct_event_request() 這個 security definer
-- function 處理，不開放直接 UPDATE——分階段輪到誰審核、核准後要不要接著送下一關、
-- 全部核准後要不要寫進 conduct_events，邏輯比單純的 RLS 條件複雜很多，集中寫在
-- 一個函式裡才不會各處分散、顧此失彼。

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
  v_unit_points int;
  v_new_id uuid;
begin
  if p_decision not in ('同意', '不同意') then
    raise exception '決定只能是「同意」或「不同意」';
  end if;

  select * into v_row from conduct_event_requests where id = p_id for update;
  if v_row is null then
    raise exception '找不到這筆申請';
  end if;

  if v_row.status = '待B審核' then
    if v_role <> 'admin_b' then
      raise exception '目前這筆申請輪到管理員B審核，您沒有權限審核';
    end if;
    update conduct_event_requests set
      b_decision = p_decision, b_by = v_uid, b_at = now(),
      status = case
        when p_decision = '不同意' then '已駁回'
        when v_row.event_type = '嘉獎' then '已核准'   -- 嘉獎只需要管理員B這一關
        else '待A審核'                                  -- 小功／大功還要再送管理員A
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
        when v_row.event_type = '大功' then '待S審核'  -- 大功還要再送管理員S
        else '已核准'                                    -- 小功到管理員A這關就完成
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

  -- 重新讀一次目前狀態；如果已經走完所有關卡變成「已核准」，就在這裡真的寫進
  -- conduct_events——用 on conflict 是因為同一位學生同一天同一種獎懲只能有一筆
  -- （conduct_events_student_date_type_key，sql/28），萬一剛好已經有一筆（例如
  -- 另一次申請也核准了同一天同一種獎懲），用這次核准的內容覆蓋過去，不會出現
  -- 「核准了卻因為撞到唯一限制而整個失敗」的情況。
  select * into v_row from conduct_event_requests where id = p_id;
  if v_row.status = '已核准' and v_row.applied_at is null then
    insert into conduct_events (student_no, event_date, event_type, points, reason, recorded_by)
    values (
      v_row.student_no, v_row.event_date, v_row.event_type, v_row.points, v_row.reason,
      (select id from teachers where app_user_id = v_row.requested_by)
    )
    on conflict on constraint conduct_events_student_date_type_key
    do update set points = excluded.points, reason = excluded.reason, recorded_by = excluded.recorded_by
    returning id into v_new_id;
    update conduct_event_requests set applied_at = now(), conduct_event_id = v_new_id where id = p_id;
  end if;
end;
$$;

revoke all on function decide_conduct_event_request(uuid, text) from public, anon;
grant execute on function decide_conduct_event_request(uuid, text) to authenticated;

-- 上一輪（sql/93）讓「其他教師」可以直接 insert conduct_events（嘉獎/小功、單筆
-- 上限1小功）——這一輪改成一律要先送審，教師不再能直接寫入 conduct_events，
-- 移除這條政策；訓導/系統管理員S 直接讀寫（discipline_write_conduct_events）
-- 維持不變，管理／校正既有紀錄、登記懲處都還是用得到。
drop policy if exists teacher_insert_conduct_events on conduct_events;

notify pgrst, 'reload schema';
