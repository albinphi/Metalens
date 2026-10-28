import './globals.css';

export const metadata = {
  title: 'MetaLens — Commodity Derivatives Intelligence',
  description: 'Historical gold derivatives analytics and research workspace',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
