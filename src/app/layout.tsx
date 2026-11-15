import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

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
    <html lang="ko" className={`dark ${geistSans.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col font-sans text-primary">
        {children}
      </body>
    </html>
  );
}
