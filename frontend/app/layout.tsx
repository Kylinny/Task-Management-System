import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HappyRobot Task Management",
  description: "Collaborative project boards for real-time task coordination",
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
