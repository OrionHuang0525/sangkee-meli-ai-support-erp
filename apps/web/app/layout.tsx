import "./styles.css";

export const metadata = {
  title: "Mercado Libre 客服工作台",
  description: "Mercado Libre 客服处理与回复审核工作台"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
