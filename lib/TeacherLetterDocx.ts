import { Document, Packer, Paragraph, TextRun, AlignmentType } from 'docx';
import { CertificateContent, AppointmentContent } from './teacherLetterContent';

// PDF跟Word共用同一份內容（lib/teacherLetterContent.ts 算出來的資料），這裡只負責排版成
// .docx——docx套件是純JS、瀏覽器端也能跑，不需要另外開Next.js API route，做法跟現有Excel
// 產生（xlsx套件）一致。docx套件本身內建處理Unicode/中文字，不需要另外註冊字型。

function p(text: string, opts: { bold?: boolean; size?: number; align?: (typeof AlignmentType)[keyof typeof AlignmentType]; spacingAfter?: number } = {}) {
  return new Paragraph({
    alignment: opts.align,
    spacing: { after: opts.spacingAfter ?? 120 },
    children: [new TextRun({ text, bold: opts.bold, size: opts.size ?? 24 })],
  });
}

export async function buildCertificateDocxBlob(data: CertificateContent): Promise<Blob> {
  const doc = new Document({
    sections: [
      {
        children: [
          p(data.schoolTitle, { bold: true, size: 32, align: AlignmentType.CENTER, spacingAfter: 240 }),
          p(`校長：${data.principalName}`, { align: AlignmentType.RIGHT }),
          p(`姓名：${data.name}　　出生年月日：${data.birthDate}`),
          p(`性別：${data.gender}　　國籍：${data.nationality}`),
          p(`服務部門：${data.department}　　擔任職務：${data.title}`),
          p('任職起訖時間：', { spacingAfter: 60 }),
          ...data.serviceSegments.map((s) => p(`自 ${s.start} 起 至 ${s.end} 止`)),
          p(`${data.serviceDurationLabel}　${data.employmentStatusLabel}`),
          p(`備註：${data.note}`, { spacingAfter: 480 }),
          p(`校長：${data.principalName}`),
          p(`聯絡電話：${data.phone}`),
          p(`地址：${data.address}`),
          p(data.issueDateLabel),
          p('※以上各項資料均屬確實無誤，如有不實願負一切法律責任'),
        ],
      },
    ],
  });
  return Packer.toBlob(doc);
}

export async function buildAppointmentDocxBlob(data: AppointmentContent): Promise<Blob> {
  const doc = new Document({
    sections: [
      {
        children: [
          p('聘　書', { bold: true, size: 32, align: AlignmentType.CENTER, spacingAfter: 240 }),
          p(`茲敦聘 ${data.name} ${data.genderTitle}`),
          p(data.positionLine),
          p('約聘期間：', { spacingAfter: 60 }),
          p(`自 ${data.startDateLabel} 起，`),
          p(`至 ${data.endDateLabel} 止。`, { spacingAfter: 240 }),
          p('此聘', { spacingAfter: 480 }),
          p(data.closingLine1),
          p(data.closingLine2),
          p(data.signatureLine, { spacingAfter: 120 }),
          p(data.issueDateLabel),
        ],
      },
    ],
  });
  return Packer.toBlob(doc);
}
