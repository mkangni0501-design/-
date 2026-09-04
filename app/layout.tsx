export const metadata = {
  title: '學校成績系統',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body style={{ fontFamily: 'sans-serif', background: '#F7F6F3', margin: 0 }}>
        {children}
      </body>
    </html>
  );
}
