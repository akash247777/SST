import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'VaaniFlow SST — Real-Time Multilingual Speech to Text',
  description:
    'Real-time multilingual Speech-to-Text studio (Hindi + English / Hinglish) powered by faster-whisper, Hugging Face, Vercel, and MongoDB.',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}
    >
      <body className="min-h-full bg-background text-foreground selection:bg-indigo-500/30 selection:text-indigo-100">
        {children}
      </body>
    </html>
  );
}
