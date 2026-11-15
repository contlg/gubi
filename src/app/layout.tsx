import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Gubi",
  description: "취향에 맞는 드라이브 코스를 설계합니다",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className="dark h-full antialiased">
      <body className="flex min-h-full flex-col font-sans text-primary">
        {children}
      </body>
    </html>
  );
}
