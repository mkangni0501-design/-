import type { SchedulerProjectData } from './schedulerBackupClient';

// 這個檔案把 public/scheduler/scheduler-tool.html 裡「匯出Excel」的排版邏輯搬過來一份，
// 純粹操作傳入的 GRADES/S 資料（不依賴瀏覽器全域變數/DOM），這樣開發人員區的「一鍵下載」
// 也可以組出跟排課工具本身「匯出Excel」內容相同的8張工作表，不用打開排課工具再手動存一次。
// 如果之後 scheduler-tool.html 那邊的匯出格式改了，這裡要記得一起改，兩邊目前是各自一份程式碼。

const DAYS = ['一', '二', '三', '四', '五', '六'];

function buildColMap(weekday: number, sat: number): Record<string, number> {
  const m: Record<string, number> = {};
  for (let d = 0; d < 5; d++) for (let p = 1; p <= weekday; p++) m['週' + DAYS[d] + '-' + p] = 3 + d * 3 + (p - 1);
  for (let p = 1; p <= sat; p++) m['週六-' + p] = 18 + (p - 1);
  return m;
}

function allTeacherNames(S: SchedulerProjectData['S']): string[] {
  const set = new Set<string>();
  Object.values(S.teachers ?? {}).forEach((clsMap) =>
    Object.values(clsMap).forEach((subMap) => Object.values(subMap).forEach((t) => t && set.add(t)))
  );
  Object.values(S.homerooms ?? {}).forEach((t) => t && set.add(t));
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-Hant'));
}

function buildTeacherScheduleMap(S: SchedulerProjectData['S']): Record<string, Record<string, { cls: string; sub: string }>> {
  const map: Record<string, Record<string, { cls: string; sub: string }>> = {};
  Object.entries(S.schedules ?? {}).forEach(([cls, sched]) => {
    sched.entries.forEach((e) => {
      if (!e.teacher || !e.sub) return;
      if (!map[e.teacher]) map[e.teacher] = {};
      map[e.teacher][e.slot] = { cls, sub: e.sub };
    });
  });
  return map;
}

function allSchoolSlots(): string[] {
  const a: string[] = [];
  for (let d = 0; d < 5; d++) for (let p = 1; p <= 3; p++) a.push('週' + DAYS[d] + '-' + p);
  for (let p = 1; p <= 5; p++) a.push('週六-' + p);
  return a;
}

function freeTeachersAt(slot: string, teacherMap: ReturnType<typeof buildTeacherScheduleMap>, teachers: string[]): string[] {
  return teachers.filter((t) => !(teacherMap[t] && teacherMap[t][slot]));
}

/** 對應排課工具「匯出Excel」的8張工作表，回傳 {工作表名稱, 資料(二維陣列)} 陣列，供呼叫端自行 aoa_to_sheet。 */
export function buildSchedulerExportSheetData(data: SchedulerProjectData): { name: string; aoa: any[][] }[] {
  const GRADES = data.GRADES ?? [];
  const S = data.S;
  const sheets: { name: string; aoa: any[][] }[] = [];

  // 1. 匯入教師 & 導師資料
  {
    const rows: any[][] = [];
    GRADES.forEach((g) => {
      g.classes.forEach((cls) => {
        const subs = g.subs.map((s) => s.n);
        rows.push([cls, ...subs]);
        const tMap = (S.teachers[g.id] && S.teachers[g.id][cls]) || {};
        rows.push([S.homerooms[cls] || '', ...subs.map((s) => tMap[s] || '')]);
      });
    });
    sheets.push({ name: '匯入教師 & 導師資料', aoa: rows });
  }

  // 2. 匯入的年級&科目&節數
  {
    const rows: any[][] = [];
    GRADES.forEach((g) => {
      rows.push([g.name]);
      g.subs.forEach((s) => rows.push([s.n, s.c]));
    });
    sheets.push({ name: '匯入的年級&科目&節數', aoa: rows });
  }

  // 3/4. 全校總課表(輸入) ／ 課表模板(修改用)：內容相同，固定23欄版面（跟匯入解析邏輯的欄位對應一致）
  {
    const rows: any[][] = [];
    const r1 = new Array(23).fill('');
    r1[1] = '全校總課表（輸入）';
    rows.push(r1);
    const r2 = new Array(23).fill('');
    r2[1] = '班級';
    ([[3, '星期一'], [6, '星期二'], [9, '星期三'], [12, '星期四'], [15, '星期五'], [18, '星期六']] as [number, string][]).forEach(([col, label]) => {
      r2[col - 1] = label;
    });
    rows.push(r2);
    const r3 = new Array(23).fill('');
    r3[1] = '節數';
    [1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 4, 5].forEach((p, i) => (r3[i + 2] = p));
    rows.push(r3);

    GRADES.forEach((g) => {
      g.classes.forEach((cls) => {
        const sched = S.schedules[cls];
        if (!sched) return;
        const colMap = buildColMap(g.weekday, g.sat);
        const entryMap: Record<string, { sub: string; teacher: string }> = {};
        sched.entries.forEach((e) => (entryMap[e.slot] = e));

        const subRow = new Array(23).fill('');
        subRow[1] = cls;
        Object.keys(colMap).forEach((slot) => {
          const col = colMap[slot] - 1;
          const e = entryMap[slot];
          subRow[col] = e && e.sub ? e.sub : '';
        });
        if (g.weekday < 3) for (let d = 0; d < 5; d++) subRow[3 + d * 3 + 2 - 1] = '放學';
        rows.push(subRow);

        const tchRow = new Array(23).fill('');
        tchRow[1] = S.homerooms[cls] || '';
        Object.keys(colMap).forEach((slot) => {
          const col = colMap[slot] - 1;
          const e = entryMap[slot];
          tchRow[col] = e && e.teacher ? e.teacher : '';
        });
        rows.push(tchRow);
      });
    });
    sheets.push({ name: '全校總課表(輸入)', aoa: rows });
    sheets.push({ name: '課表模板(修改用)', aoa: rows });
  }

  const FULL_SLOTS = allSchoolSlots();
  const teacherMap = buildTeacherScheduleMap(S);
  const allTeachers = allTeacherNames(S);

  // 5. 全校教師任課表
  {
    const rows: any[][] = [];
    const r2 = new Array(2 + FULL_SLOTS.length).fill('');
    r2[0] = '老師';
    ([[2, '星期一'], [5, '星期二'], [8, '星期三'], [11, '星期四'], [14, '星期五'], [17, '星期六']] as [number, string][]).forEach(([col, label]) => {
      r2[col] = label;
    });
    rows.push(r2);
    const r3 = new Array(2 + FULL_SLOTS.length).fill('');
    r3[0] = '節數';
    [1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 4, 5].forEach((p, i) => (r3[i + 2] = p));
    rows.push(r3);
    allTeachers.forEach((t) => {
      const row = new Array(2 + FULL_SLOTS.length).fill('');
      row[0] = t;
      FULL_SLOTS.forEach((slot, i) => {
        const info = teacherMap[t] && teacherMap[t][slot];
        row[2 + i] = info ? info.sub + '(' + info.cls + ')' : '空';
      });
      rows.push(row);
    });
    sheets.push({ name: '全校教師任課表', aoa: rows });
  }

  // 6. 各教師課表
  {
    const rows: any[][] = [];
    allTeachers.forEach((t) => {
      rows.push([t + ' 教師課表']);
      rows.push(['節/星期', ...DAYS]);
      for (let p = 1; p <= 5; p++) {
        const row: any[] = [p];
        for (let di = 0; di < 6; di++) {
          if (di < 5 && p > 3) {
            row.push('');
            continue;
          }
          const sl = '週' + DAYS[di] + '-' + p;
          const info = teacherMap[t] && teacherMap[t][sl];
          row.push(info ? info.sub + '(' + info.cls + ')' : '空');
        }
        rows.push(row);
      }
      rows.push([]);
    });
    sheets.push({ name: '各教師課表', aoa: rows });
  }

  // 7. 各班課表
  {
    const rows: any[][] = [];
    GRADES.forEach((g) => {
      g.classes.forEach((cls) => {
        const sched = S.schedules[cls];
        if (!sched) return;
        const em: Record<string, { sub: string; teacher: string }> = {};
        sched.entries.forEach((e) => (em[e.slot] = e));
        rows.push([cls + ' 課程表', '', '', '', '', '導師:', S.homerooms[cls] || '']);
        rows.push(['節/星期', ...DAYS]);
        const maxRows = Math.max(g.weekday, g.sat);
        for (let p = 1; p <= maxRows; p++) {
          const subRow: any[] = [p + ' 科目'];
          const tRow: any[] = ['　　老師'];
          for (let di = 0; di < 6; di++) {
            if (di === 5 && p > g.sat) {
              subRow.push('');
              tRow.push('');
              continue;
            }
            const sl = '週' + DAYS[di] + '-' + p;
            if (di < 5 && p === 3 && g.weekday < 3) {
              subRow.push('放學');
              tRow.push('');
              continue;
            }
            if (di < 5 && p > g.weekday) {
              subRow.push('');
              tRow.push('');
              continue;
            }
            const e = em[sl];
            subRow.push(e && e.sub ? e.sub : '');
            tRow.push(e && e.teacher ? e.teacher : '');
          }
          rows.push(subRow);
          rows.push(tRow);
        }
        rows.push([]);
      });
    });
    sheets.push({ name: '各班課表', aoa: rows });
  }

  // 8. 值日教師參考
  {
    const freeLists = FULL_SLOTS.map((slot) => freeTeachersAt(slot, teacherMap, allTeachers));
    const maxLen = freeLists.reduce((m, l) => Math.max(m, l.length), 0);
    const rows: any[][] = [];
    const r2 = new Array(2 + FULL_SLOTS.length).fill('');
    r2[0] = '星期';
    ([[2, '星期一'], [5, '星期二'], [8, '星期三'], [11, '星期四'], [14, '星期五'], [17, '星期六']] as [number, string][]).forEach(([col, label]) => {
      r2[col] = label;
    });
    rows.push(r2);
    const r3 = new Array(2 + FULL_SLOTS.length).fill('');
    r3[0] = '節數';
    [1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 4, 5].forEach((p, i) => (r3[i + 2] = p));
    rows.push(r3);
    const r4 = new Array(2 + FULL_SLOTS.length).fill('');
    r4[0] = '無課教師';
    rows.push(r4);
    for (let r = 0; r < maxLen; r++) {
      const row = new Array(2 + FULL_SLOTS.length).fill('');
      FULL_SLOTS.forEach((slot, i) => (row[2 + i] = freeLists[i][r] || ''));
      rows.push(row);
    }
    sheets.push({ name: '值日教師參考', aoa: rows });
  }

  return sheets;
}
