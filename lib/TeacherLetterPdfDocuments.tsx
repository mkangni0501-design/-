import { Document, Page, Text, View, StyleSheet, Font } from '@react-pdf/renderer';
import { CertificateContent, AppointmentContent } from './teacherLetterContent';

// 【2026-08-10 新增】react-pdf 預設字型不含中文字，之前 lib/ReportCardDocument.tsx 也提醒過這件事
// 但一直沒有真的補上字型檔——這裡的內容幾乎全是中文，沒有字型會整份印出來是空白/方框。
// 已經把 Noto Sans TC（繁體中文）的字型檔放進 public/fonts/，這裡註冊起來給所有聘書/證明PDF共用。
Font.register({
  family: 'NotoSansTC',
  fonts: [
    { src: '/fonts/NotoSansTC-Regular.woff2', fontWeight: 400 },
    { src: '/fonts/NotoSansTC-Bold.woff2', fontWeight: 700 },
  ],
});

const styles = StyleSheet.create({
  page: { padding: 48, fontSize: 12, fontFamily: 'NotoSansTC', lineHeight: 1.6 },
  centerTitle: { fontSize: 18, textAlign: 'center', marginBottom: 24, fontWeight: 700 },
  row: { flexDirection: 'row', marginBottom: 8 },
  col: { flexDirection: 'row', flex: 1 },
  label: { width: 90 },
  value: { flex: 1 },
  section: { marginTop: 12, marginBottom: 12 },
  segmentRow: { flexDirection: 'row', marginBottom: 4 },
  footer: { marginTop: 48 },
  footerLine: { marginBottom: 4 },
});

export function CertificateDocument({ data }: { data: CertificateContent }) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.row}>
          <Text style={{ flex: 1 }}></Text>
        </View>
        <Text style={styles.centerTitle}>{data.schoolTitle}</Text>
        <View style={{ textAlign: 'right', marginBottom: 12 }}>
          <Text>校長：{data.principalName}</Text>
        </View>

        <View style={styles.row}>
          <View style={styles.col}><Text style={styles.label}>姓名</Text><Text style={styles.value}>{data.name}</Text></View>
          <View style={styles.col}><Text style={styles.label}>出生年月日</Text><Text style={styles.value}>{data.birthDate}</Text></View>
        </View>
        <View style={styles.row}>
          <View style={styles.col}><Text style={styles.label}>性別</Text><Text style={styles.value}>{data.gender}</Text></View>
          <View style={styles.col}><Text style={styles.label}>國籍</Text><Text style={styles.value}>{data.nationality}</Text></View>
        </View>
        <View style={styles.row}>
          <View style={styles.col}><Text style={styles.label}>服務部門</Text><Text style={styles.value}>{data.department}</Text></View>
          <View style={styles.col}><Text style={styles.label}>擔任職務</Text><Text style={styles.value}>{data.title}</Text></View>
        </View>

        <View style={styles.section}>
          <Text style={{ marginBottom: 6 }}>任職起訖時間：</Text>
          {data.serviceSegments.map((s, i) => (
            <View key={i} style={styles.segmentRow}>
              <Text>自 {s.start} 起 至 {s.end} 止</Text>
            </View>
          ))}
        </View>

        <Text style={{ marginBottom: 6 }}>{data.serviceDurationLabel}　{data.employmentStatusLabel}</Text>
        <Text style={{ marginBottom: 24 }}>備註：{data.note}</Text>

        <View style={styles.footer}>
          <Text style={styles.footerLine}>校長：{data.principalName}</Text>
          <Text style={styles.footerLine}>聯絡電話：{data.phone}</Text>
          <Text style={styles.footerLine}>地址：{data.address}</Text>
          <Text style={styles.footerLine}>{data.issueDateLabel}</Text>
          <Text style={styles.footerLine}>※以上各項資料均屬確實無誤，如有不實願負一切法律責任</Text>
        </View>
      </Page>
    </Document>
  );
}

export function AppointmentDocument({ data }: { data: AppointmentContent }) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <Text style={styles.centerTitle}>聘　書</Text>

        <Text style={{ marginBottom: 12 }}>
          茲敦聘 {data.name} {data.genderTitle}
        </Text>
        <Text style={{ marginBottom: 12 }}>{data.positionLine}</Text>
        <Text style={{ marginBottom: 4 }}>約聘期間：</Text>
        <Text style={{ marginBottom: 4 }}>自 {data.startDateLabel} 起，</Text>
        <Text style={{ marginBottom: 24 }}>至 {data.endDateLabel} 止。</Text>
        <Text style={{ marginBottom: 24 }}>此聘</Text>

        <View style={styles.footer}>
          <Text style={styles.footerLine}>{data.closingLine1}</Text>
          <Text style={styles.footerLine}>{data.closingLine2}</Text>
          <Text style={{ marginTop: 24, marginBottom: 4 }}>{data.signatureLine}</Text>
          <Text style={styles.footerLine}>{data.issueDateLabel}</Text>
        </View>
      </Page>
    </Document>
  );
}
