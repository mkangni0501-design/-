import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import { registerNotoSansTC } from './pdfFonts';

// 中文字型註冊：見 lib/pdfFonts.ts 的完整說明。原本這裡完全沒有註冊字型
// （react-pdf 內建字型不含中文），除了數字以外全部印出來是亂碼，已修正。
registerNotoSansTC();

// ------------------------------------------------------------------
// 版型依「本校目前的成績單正面」樣本（使用者提供的 AI.xlsx，2026-08-15）逐欄位
// 還原：科目/比重 + 上學期/下學期各自的 期中/期末/平時/總分 + 學年成績 +
// 出席記錄 + 懲獎記錄 + 學業平均 + 操行成績（含禮貌/衣著/服務/紀律）+
// 全班人數/全班名次 + 升留級 + 家長簽章及建議 + 導師/訓導/教務/校長簽章 +
// 導師評語。反面（背面）樣本尚未提供，這次只做正面。
//
// 【資料缺口，目前先留空，等確認後再補】
// - 升留級：現有資料庫沒有對應欄位，先留空白；且依你的說明，只有印「下學期／學年」
//   成績單（上下學期都有資料）時這格才會出現，上學期單獨列印時整格空白。
// - 學校校徽/印章圖案：沒有拿到圖檔，先留空。
//
// 【已解決】操行成績「禮貌／衣著／服務／紀律」四個分項——你確認要開發新的評分介面，
// 見 components/admin-tabs/ConductScoresTab.tsx（新增的 conduct_scores 表，只有導師
// 本人/管理員能填）。操行成績＝這四個分項的平均，不是另外輸入的。
// ------------------------------------------------------------------

export type SubjectScoreRow = {
  subject: string;
  weight: number;
  midterm: number | null;
  final: number | null;
  daily: number | null;
  total: number | null;
};

export type TermBlock = {
  ready: boolean;
  subjects: SubjectScoreRow[];
  academicAverage: { midterm: number | null; final: number | null; daily: number | null; total: number | null };
  attendance: Record<'曠課' | '遲到' | '病假' | '事假' | '公假', number>;
  isPerfectAttendance: boolean;
  discipline: Record<'嘉獎' | '小功' | '大功' | '警告' | '小過' | '大過', number>;
  conduct: { politeness: number | null; dress: number | null; service: number | null; discipline: number | null; overall: number | null };
  classSize: number | null;
  classRank: number | null;
};

export type ReportCardData = {
  school: string;
  academicYear: number;
  currentTerm: string;
  gradeLevel: string;
  className: string;
  studentNo: string;
  studentName: string;
  seatNo: number;
  terms: Record<'上學期' | '下學期', TermBlock | null>;
  remark: string;
  printedAt: string;
};

const BORDER = '0.75pt solid #000';
const styles = StyleSheet.create({
  page: { padding: 16, fontFamily: 'NotoSansTC', fontSize: 8 },
  outer: { border: BORDER },

  headerRow: { flexDirection: 'row', borderBottom: BORDER, alignItems: 'stretch' },
  schoolName: { flex: 3, textAlign: 'center', fontSize: 13, fontWeight: 700, padding: 6, justifyContent: 'center' },
  yearBox: { flex: 1, textAlign: 'center', fontSize: 11, fontWeight: 700, padding: 6, backgroundColor: '#BDD7EE', borderLeft: BORDER, justifyContent: 'center' },
  termBox: { flex: 1, textAlign: 'center', fontSize: 11, fontWeight: 700, padding: 6, backgroundColor: '#A9D18E', borderLeft: BORDER, justifyContent: 'center' },
  titleBox: { flex: 1.4, textAlign: 'center', fontSize: 13, fontWeight: 700, padding: 6, borderLeft: BORDER, justifyContent: 'center' },

  infoRow: { flexDirection: 'row', borderBottom: BORDER },
  infoLabel: { padding: 5, fontSize: 9, justifyContent: 'center' },
  infoValue: { padding: 5, fontSize: 10, fontWeight: 700, backgroundColor: '#FFF2CC', justifyContent: 'center', textAlign: 'center' },
  infoValueGreen: { padding: 5, fontSize: 10, fontWeight: 700, backgroundColor: '#A9D18E', justifyContent: 'center', textAlign: 'center' },

  body: { flexDirection: 'row' },
  leftCol: { flex: 1.55, borderRight: BORDER },
  rightCol: { flex: 1 },

  row: { flexDirection: 'row', borderBottom: BORDER, minHeight: 13 },
  sectionTitle: { textAlign: 'center', fontWeight: 700, fontSize: 8.5, padding: 3, backgroundColor: '#F2F2F2', justifyContent: 'center' },
  cellHead: { textAlign: 'center', fontSize: 7.5, fontWeight: 700, padding: 2, justifyContent: 'center', borderLeft: BORDER },
  cellHeadFirst: { textAlign: 'center', fontSize: 7.5, fontWeight: 700, padding: 2, justifyContent: 'center' },
  cell: { textAlign: 'center', fontSize: 8, padding: 2, justifyContent: 'center', borderLeft: BORDER },
  cellFirst: { textAlign: 'center', fontSize: 8, padding: 2, justifyContent: 'center' },
  cellLeftLabel: { textAlign: 'center', fontSize: 8, fontWeight: 700, padding: 2, justifyContent: 'center', backgroundColor: '#FFF9E6' },
  redText: { color: '#C00000' },

  subjectCol: { width: '15%' },
  weightCol: { width: '8%' },
  scoreCol: { width: '9.75%' },
  annualCol: { width: '8%' },

  attnItemCol: { width: '30%' },
  attnValCol: { width: '23.33%' },

  signBox: { flex: 1, borderLeft: BORDER, minHeight: 34, padding: 3 },
  signLabel: { fontSize: 8, fontWeight: 700, textAlign: 'center', marginBottom: 2 },

  remarkBox: { minHeight: 40, padding: 4 },
  remarkLabel: { fontSize: 8, fontWeight: 700, marginBottom: 2 },
  remarkText: { fontSize: 8, lineHeight: 1.4 },
});

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

// 學年成績（左表最右邊那一欄）：目前只有一個學期有資料時，這欄本來就該是空白——
// 要等上/下學期都有資料，才有「一整個學年」可以算。實際合併公式（例如上下學期
// 各佔多少比重）要跟學校確認後再補，這裡先只处理「兩學期都有資料時显示什麼」
// 這件事還沒發生過（目前資料只到上學期），所以先留空，不在這裡猜一個公式出來。
function annualTotal(subject: string, terms: ReportCardData['terms']): string {
  return '';
}

function ScoreTable({ terms }: { terms: ReportCardData['terms'] }) {
  const primary = terms.上學期 ?? terms.下學期;
  const subjects = primary?.subjects ?? [];
  return (
    <View>
      {/* 科目/比重/學期表頭 */}
      <View style={styles.row}>
        <View style={[styles.cellHeadFirst, styles.subjectCol, { justifyContent: 'center' }]}>
          <Text style={{ fontSize: 10, fontWeight: 700 }}>科目</Text>
        </View>
        <View style={[styles.cellHead, styles.weightCol]}>
          <Text>比重</Text>
        </View>
        <View style={[styles.cellHead, { width: '39%' }]}>
          <Text>上學期</Text>
        </View>
        <View style={[styles.cellHead, { width: '39%' }]}>
          <Text>下學期</Text>
        </View>
        <View style={[styles.cellHead, styles.annualCol]}>
          <Text>學年成績</Text>
        </View>
      </View>
      <View style={styles.row}>
        <View style={[styles.cellFirst, styles.subjectCol]} />
        <View style={[styles.cell, styles.weightCol]} />
        {(['期中', '期末', '平時', '總分'] as const).map((h) => (
          <View key={'s' + h} style={[styles.cellHead, styles.scoreCol]}>
            <Text>{h}</Text>
          </View>
        ))}
        {(['期中', '期末', '平時', '總分'] as const).map((h) => (
          <View key={'f' + h} style={[styles.cellHead, styles.scoreCol]}>
            <Text>{h}</Text>
          </View>
        ))}
        <View style={[styles.cell, styles.annualCol]} />
      </View>

      {/* 科目列 */}
      {subjects.map((s) => {
        const fall = terms.下學期?.subjects.find((x) => x.subject === s.subject);
        return (
          <View style={styles.row} key={s.subject}>
            <View style={[styles.cellLeftLabel, styles.subjectCol]}>
              <Text>{s.subject}</Text>
            </View>
            <View style={[styles.cell, styles.weightCol]}>
              <Text>{pct(s.weight)}</Text>
            </View>
            <View style={[styles.cell, styles.scoreCol]}>
              <Text>{fmt(s.midterm)}</Text>
            </View>
            <View style={[styles.cell, styles.scoreCol]}>
              <Text>{fmt(s.final)}</Text>
            </View>
            <View style={[styles.cell, styles.scoreCol]}>
              <Text>{fmt(s.daily)}</Text>
            </View>
            <View style={[styles.cell, styles.scoreCol]}>
              <Text>{fmt(s.total)}</Text>
            </View>
            <View style={[styles.cell, styles.scoreCol]}>
              <Text>{fmt(fall?.midterm)}</Text>
            </View>
            <View style={[styles.cell, styles.scoreCol]}>
              <Text>{fmt(fall?.final)}</Text>
            </View>
            <View style={[styles.cell, styles.scoreCol]}>
              <Text>{fmt(fall?.daily)}</Text>
            </View>
            <View style={[styles.cell, styles.scoreCol]}>
              <Text>{fmt(fall?.total)}</Text>
            </View>
            <View style={[styles.cell, styles.annualCol]}>
              <Text>{annualTotal(s.subject, terms)}</Text>
            </View>
          </View>
        );
      })}

      {/* 學業平均 */}
      <View style={styles.row}>
        <View style={[styles.cellLeftLabel, styles.subjectCol]}>
          <Text>學業平均</Text>
        </View>
        <View style={[styles.cell, styles.weightCol]} />
        {(['midterm', 'final', 'daily', 'total'] as const).map((k) => (
          <View key={'sa' + k} style={[styles.cell, styles.scoreCol]}>
            <Text>{fmt(terms.上學期?.academicAverage[k])}</Text>
          </View>
        ))}
        {(['midterm', 'final', 'daily', 'total'] as const).map((k) => (
          <View key={'fa' + k} style={[styles.cell, styles.scoreCol]}>
            <Text>{fmt(terms.下學期?.academicAverage[k])}</Text>
          </View>
        ))}
        <View style={[styles.cell, styles.annualCol]} />
      </View>

      {/* 操行成績 + 禮貌/衣著/服務/紀律：見 components/admin-tabs/ConductScoresTab.tsx
          （導師/管理員輸入的地方）。操行成績＝四個分項的平均，不是另外輸入的。
          目前上/下學期都各自獨立一組（跟其他科目一樣），哪個學期沒有資料就留空白。 */}
      {(
        [
          { label: '操行成績', key: 'overall' as const },
          { label: '禮貌', key: 'politeness' as const },
          { label: '衣著', key: 'dress' as const },
          { label: '服務', key: 'service' as const },
          { label: '紀律', key: 'discipline' as const },
        ]
      ).map(({ label, key }) => (
        <View style={styles.row} key={label}>
          <View style={[styles.cellLeftLabel, styles.subjectCol]}>
            <Text>{label}</Text>
          </View>
          <View style={[styles.cell, styles.weightCol]} />
          <View style={[styles.cell, { width: '39%' }]}>
            <Text>{fmt(terms.上學期?.conduct[key])}</Text>
          </View>
          <View style={[styles.cell, { width: '39%' }]}>
            <Text>{fmt(terms.下學期?.conduct[key])}</Text>
          </View>
          <View style={[styles.cell, styles.annualCol]} />
        </View>
      ))}
    </View>
  );
}

function AttendanceDisciplinePanel({ terms }: { terms: ReportCardData['terms'] }) {
  const spring = terms.上學期;
  const fall = terms.下學期;
  const attnKeys = ['曠課', '遲到', '病假', '事假', '公假'] as const;
  const discKeys = ['嘉獎', '小功', '大功', '警告', '小過', '大過'] as const;

  return (
    <View>
      <View style={styles.row}>
        <View style={[styles.sectionTitle, { width: '50%' }]}>
          <Text>出席記錄</Text>
        </View>
        <View style={[styles.sectionTitle, { width: '50%', borderLeft: BORDER }]}>
          <Text>懲獎記錄</Text>
        </View>
      </View>
      <View style={styles.row}>
        <View style={[styles.cellHeadFirst, styles.attnItemCol]}>
          <Text>項目</Text>
        </View>
        <View style={[styles.cellHead, styles.attnValCol]}>
          <Text>上學期</Text>
        </View>
        <View style={[styles.cellHead, styles.attnValCol]}>
          <Text>下學期</Text>
        </View>
        <View style={[styles.cellHead, styles.attnValCol]}>
          <Text>合計</Text>
        </View>
        <View style={[styles.cellHead, styles.attnItemCol, { borderLeft: BORDER }]}>
          <Text>項目</Text>
        </View>
        <View style={[styles.cellHead, styles.attnValCol]}>
          <Text>上學期</Text>
        </View>
        <View style={[styles.cellHead, styles.attnValCol]}>
          <Text>下學期</Text>
        </View>
        <View style={[styles.cellHead, styles.attnValCol]}>
          <Text>合計</Text>
        </View>
      </View>
      {[0, 1, 2, 3, 4, 5].map((i) => {
        const attnKey = attnKeys[i];
        const discKey = discKeys[i];
        const springV = attnKey ? spring?.attendance[attnKey] : undefined;
        const fallV = attnKey ? fall?.attendance[attnKey] : undefined;
        const total = (springV ?? 0) + (fallV ?? 0);
        const dSpringV = spring?.discipline[discKey];
        const dFallV = fall?.discipline[discKey];
        const dTotal = (dSpringV ?? 0) + (dFallV ?? 0);
        return (
          <View style={styles.row} key={i}>
            <View style={[styles.cellLeftLabel, styles.attnItemCol]}>
              <Text>{attnKey ?? ''}</Text>
            </View>
            <View style={[styles.cell, styles.attnValCol]}>
              <Text>{attnKey ? springV ?? '' : ''}</Text>
            </View>
            <View style={[styles.cell, styles.attnValCol]}>
              <Text>{attnKey ? fallV ?? '' : ''}</Text>
            </View>
            <View style={[styles.cell, styles.attnValCol]}>
              <Text>{attnKey ? total : ''}</Text>
            </View>
            <View style={[styles.cellLeftLabel, styles.attnItemCol, { borderLeft: BORDER }]}>
              <Text>{discKey}</Text>
            </View>
            <View style={[styles.cell, styles.attnValCol]}>
              <Text>{dSpringV ?? ''}</Text>
            </View>
            <View style={[styles.cell, styles.attnValCol]}>
              <Text>{dFallV ?? ''}</Text>
            </View>
            <View style={[styles.cell, styles.attnValCol]}>
              <Text>{dTotal}</Text>
            </View>
          </View>
        );
      })}
      {/* 全勤（獨立一列，跟上面五個假別放在一起看，樣本裡是"是/否"文字，不是次數） */}
      <View style={styles.row}>
        <View style={[styles.cellLeftLabel, styles.attnItemCol]}>
          <Text>全勤</Text>
        </View>
        <View style={[styles.cell, styles.attnValCol]}>
          <Text>{spring ? (spring.isPerfectAttendance ? '是' : '否') : ''}</Text>
        </View>
        <View style={[styles.cell, styles.attnValCol]}>
          <Text>{fall ? (fall.isPerfectAttendance ? '是' : '否') : ''}</Text>
        </View>
        <View style={[styles.cell, styles.attnValCol]}>
          <Text>{[spring, fall].filter((t) => t?.isPerfectAttendance).length || ''}</Text>
        </View>
        <View style={[styles.cell, { width: '50%' }, { borderLeft: BORDER }]} />
      </View>

      {/* 全班人數／全班名次 */}
      <View style={[styles.row, { minHeight: 22 }]}>
        <View style={[styles.sectionTitle, { width: '25%' }]}>
          <Text>全班人數</Text>
        </View>
        <View style={{ width: '25%', borderLeft: BORDER }}>
          <View style={{ borderBottom: BORDER, padding: 2 }}>
            <Text style={{ fontSize: 7 }}>上學期 {spring?.classSize ?? ''}</Text>
          </View>
          <View style={{ padding: 2 }}>
            <Text style={{ fontSize: 7 }}>下學期 {fall?.classSize ?? ''}</Text>
          </View>
        </View>
        <View style={[styles.sectionTitle, { width: '25%', borderLeft: BORDER }]}>
          <Text>全班名次</Text>
        </View>
        <View style={{ width: '25%', borderLeft: BORDER }}>
          <View style={{ borderBottom: BORDER, padding: 2 }}>
            <Text style={{ fontSize: 7 }}>上學期 {spring?.classRank ?? ''}</Text>
          </View>
          <View style={{ padding: 2 }}>
            <Text style={{ fontSize: 7 }}>下學期 {fall?.classRank ?? ''}</Text>
          </View>
        </View>
      </View>

      {/* 升留級／家長簽章及建議：升留級目前無資料來源（先留空）；而且依你的說明，
          這格只有印「下學期／學年成績」的成績單（也就是上下學期都有資料，可以算出
          整年總成績）時才會出現，上學期單獨列印時這格要完全空白，連「升留級」這個
          標籤都不顯示。 */}
      <View style={[styles.row, { minHeight: 34 }]}>
        <View style={[styles.sectionTitle, { width: '25%' }]}>
          <Text>{spring && fall ? '升留級' : ''}</Text>
        </View>
        <View style={[styles.sectionTitle, { width: '75%', borderLeft: BORDER }]}>
          <Text>家長簽章及建議</Text>
        </View>
      </View>

      {/* 簽章列 */}
      <View style={[styles.row, { minHeight: 30, borderBottom: 'none' }]}>
        {['導師簽章', '訓導簽章', '教務簽章', '校長簽章'].map((label, i) => (
          <View key={label} style={[styles.signBox, i === 0 ? { borderLeft: 0 } : {}]}>
            <Text style={styles.signLabel}>{label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

export function ReportCardDocument({ data }: { data: ReportCardData }) {
  return (
    <Document>
      <Page size="A4" orientation="landscape" style={styles.page}>
        <View style={styles.outer}>
          <View style={styles.headerRow}>
            <View style={styles.schoolName}>
              <Text>{data.school}</Text>
            </View>
            <View style={styles.yearBox}>
              <Text>{data.academicYear} 學年度</Text>
            </View>
            <View style={styles.termBox}>
              <Text>{data.currentTerm}</Text>
            </View>
            <View style={styles.titleBox}>
              <Text>成績通知書</Text>
            </View>
          </View>
          <View style={styles.infoRow}>
            <View style={[styles.infoLabel, { width: '6%' }]}>
              <Text>學號：</Text>
            </View>
            <View style={[styles.infoValue, { width: '12%' }]}>
              <Text>{data.studentNo}</Text>
            </View>
            <View style={[styles.infoLabel, { width: '40%' }]} />
            <View style={[styles.infoLabel, { width: '8%' }]}>
              <Text>學生姓名：</Text>
            </View>
            <View style={[styles.infoValue, { width: '10%' }]}>
              <Text>{data.studentName}</Text>
            </View>
            <View style={[styles.infoValue, { width: '10%' }]}>
              <Text>{data.gradeLevel}</Text>
            </View>
            <View style={[styles.infoValue, { width: '8%' }]}>
              <Text>{data.className}班</Text>
            </View>
            <View style={[styles.infoValueGreen, { width: '6%' }]}>
              <Text>{String(data.seatNo).padStart(2, '0')}號</Text>
            </View>
          </View>

          <View style={styles.body}>
            <View style={styles.leftCol}>
              <ScoreTable terms={data.terms} />
            </View>
            <View style={styles.rightCol}>
              <AttendanceDisciplinePanel terms={data.terms} />
            </View>
          </View>

          <View style={[styles.remarkBox, { borderTop: BORDER }]}>
            <Text style={styles.remarkLabel}>導師評語</Text>
            <Text style={styles.remarkText}>{data.remark}</Text>
          </View>
        </View>
      </Page>
    </Document>
  );
}
