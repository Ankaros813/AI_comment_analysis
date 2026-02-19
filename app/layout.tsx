import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "AI Comment Analyzer",
  description: "Vercel-ready realtime comment analysis with Supabase + OpenRouter",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

