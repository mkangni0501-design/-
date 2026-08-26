-- ============================================================
-- 修正「班級批次上傳成績,會無法顯示於其他排名頁面」
-- ------------------------------------------------------------
-- 追查結果：class_rankings / grade_rankings 這兩個view是否顯示期中考/期末考/平時分，
-- 是靠 exam_type_locked() 這個函式決定的（sql/21ranking_lock_granularity_fix.sql）。
-- 但這個函式從一開始就「只檢查 scope='班級' 那一筆」，完全沒有理會 submission_windows
-- 表原本設計就有的 scope='部別'／scope='全校' 這兩種範圍。而系統裡目前唯一「鎖定」的
-- 操作入口，是導師在「班級成績總表」頁面點的「確認送出並鎖定」按鈕——那顆按鈕只會鎖
-- 「平時分、自己班」，從來沒有任何畫面可以鎖「期中考」「期末考」。
-- 結果就是：老師/管理員批次上傳期中考、期末考成績後，因為永遠沒有任何一筆
-- submission_windows 把該班的「期中考」「期末考」設成 is_locked=true，
-- class_rankings/grade_rankings 這兩個view就永遠只會顯示 null，看起來就像
-- 「成績上傳了，但排名頁面看不到」。
--
-- 這裡的修正：
--   1. exam_type_locked() 改成「班級鎖定優先，沒有班級層級的設定時，往上看部別、
--      再往上看全校」——這樣管理員可以直接鎖「全校的期末考」一次搞定，不用每個
--      班都點一次，也保留了「這個班要另外處理（例如緩考、成績有疑義）」時，
--      單獨對那個班設定就會蓋過部別/全校的設定的彈性。
--   2. 新增開發人員頁「成績上傳時間設定表」(app/(app)/admin/score-submission-windows)，
--      提供教務處/系統管理員實際操作這幾個鎖定的畫面（過去完全沒有畫面可以設定
--      班級以外的範圍，也沒有畫面可以鎖期中考/期末考）。
-- ============================================================

create or replace function exam_type_locked(
  p_class_id uuid, p_academic_year int, p_term text, p_data_type text
) returns boolean as $$
  select coalesce(
    -- 1. 這個班自己有沒有設定（不管鎖或不鎖，只要有設定就以這筆為準，
    --    才能讓「這個班要單獨處理」蓋過部別/全校的統一設定）
    (select sw.is_locked from submission_windows sw
      where sw.data_type = p_data_type and sw.scope = '班級'
        and sw.scope_ref = p_class_id::text
        and sw.academic_year = p_academic_year and sw.term = p_term
      limit 1),
    -- 2. 沒有班級層級的設定，改看這個班「部別」有沒有設定
    (select sw.is_locked from submission_windows sw
      join classes c on c.id = p_class_id
      where sw.data_type = p_data_type and sw.scope = '部別'
        and sw.scope_ref = c.department
        and sw.academic_year = p_academic_year and sw.term = p_term
      limit 1),
    -- 3. 都沒有，看「全校」有沒有設定
    (select sw.is_locked from submission_windows sw
      where sw.data_type = p_data_type and sw.scope = '全校'
        and sw.academic_year = p_academic_year and sw.term = p_term
      limit 1),
    false
  );
$$ language sql stable;

-- ------------------------------------------------------------
-- 附帶提醒：submission_windows 原本的 unique 限制是 (academic_year, term, data_type,
-- scope, scope_ref)。scope='全校' 時如果 scope_ref 存成 null，Postgres 的 unique
-- 限制「NULL 不會互相衝突」，會讓同一個「全校、期末考」設定可以無限重複新增、
-- upsert（onConflict）也會失效。因此新設定頁一律把 scope='全校' 的 scope_ref
-- 存成空字串 ''（不存 null），這樣就落在原本的 unique 限制保護範圍內，不需要
-- 更動資料庫的限制本身。以下把資料庫裡「可能已經存在」的 null 值統一整理成空字串，
-- 避免萬一有舊資料導致的重複列。
update submission_windows set scope_ref = '' where scope = '全校' and scope_ref is null;
