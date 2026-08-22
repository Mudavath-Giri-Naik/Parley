import type { Metadata } from 'next';
import { config } from '@/lib/config';
import './globals.css';

export const metadata: Metadata = {
  title: `${config.merchant.name || 'Parley'} · agent commerce`,
  description: `Parley seller agent for ${config.merchant.name || 'this merchant'}: catalog, negotiation, bounded payments, and a full audit trail.`,
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
