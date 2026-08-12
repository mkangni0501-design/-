import { Document, Page, Text, View, StyleSheet, Font } from '@react-pdf/renderer';

// 說明：這裡先用內建字型示意版型結構。實際上線前，建議改註冊一套支援中文/泰文的字型
// （例如思源黑體 Noto Sans TC、Noto Sans Thai），否則中文字會顯示不出來。
// Font.register({ family: 'NotoSansTC', src: '/fonts/NotoSansTC-Regular.ttf' });

const styles = StyleSheet.create({
  page: { padding: 32, fontSize: 11 },
  header: { textAlign: 'center', marginBottom: 16 },
  schoolName: { fontSize: 16, marginBottom: 4 },
  title: { fontSize: 14, marginBottom: 12 },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 },
  table: { display: 'flex', width: '100%', marginBottom: 12 },
  tableRow: { flexDirection: 'row', borderBottom: '1px solid #999' },
  tableHeaderRow: { flexDirection: 'row', borderBottom: '1px solid #333', fontWeight: 700 },
  cellSubject: { width: '28%', padding: 4 },
  cell: { width: '18%', padding: 4, textAlign: 'center' },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 },
  remarkBox: { marginTop: 16, border: '1px solid #ccc', padding: 8, minHeight: 60 },
});

export type ReportCardData = {
  schoolName: string;
  academicYear: number;
  term: string;
  className: string;
  seatNo: number;
  studentName: string;
  subjects: { subject: string; midterm: number | null; final: number | null; daily: number | null; weightedScore: number }[];
  totalScore: number;
  classRank: number;
  gradeRank: number;
  conduct: number;
  attendanceSummary: string; // 例如「曠課2、遲到0、病假1、事假7」
  remark: string;
};

export function ReportCardDocument({ data }: { data: ReportCardData }) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.schoolName}>{data.schoolName}</Text>
          <Text style={styles.title}>
            {data.academicYear}學年度 {data.term} 成績單
          </Text>
        </View>

        <View style={styles.infoRow}>
          <Text>班級：{data.className}</Text>
          <Text>座號：{data.seatNo}</Text>
          <Text>姓名：{data.studentName}</Text>
        </View>

        <View style={styles.table}>
          <View style={styles.tableHeaderRow}>
            <Text style={styles.cellSubject}>科目</Text>
            <Text style={styles.cell}>期中考</Text>
            <Text style={styles.cell}>期末考</Text>
            <Text style={styles.cell}>平時分</Text>
            <Text style={styles.cell}>加權小計</Text>
          </View>
          {data.subjects.map((s) => (
            <View style={styles.tableRow} key={s.subject}>
              <Text style={styles.cellSubject}>{s.subject}</Text>
              <Text style={styles.cell}>{s.midterm ?? '—'}</Text>
              <Text style={styles.cell}>{s.final ?? '—'}</Text>
              <Text style={styles.cell}>{s.daily ?? '—'}</Text>
              <Text style={styles.cell}>{s.weightedScore.toFixed(2)}</Text>
            </View>
          ))}
        </View>

        <View style={styles.summaryRow}>
          <Text>總分：{data.totalScore}</Text>
          <Text>班排名：{data.classRank}</Text>
          <Text>年級排名：{data.gradeRank}</Text>
          <Text>操行：{data.conduct}</Text>
        </View>

        <View style={styles.summaryRow}>
          <Text>出缺勤：{data.attendanceSummary}</Text>
        </View>

        <View style={styles.remarkBox}>
          <Text>導師評語：{data.remark}</Text>
        </View>
      </Page>
    </Document>
  );
}
