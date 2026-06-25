import "./globals.css";

export const metadata = {
  title: "SKU Lookup",
  description: "全網 SKU 產品資料查詢工具",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-HK">
      <body className="font-sans antialiased">
        <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">{children}</div>
      </body>
    </html>
  );
}
