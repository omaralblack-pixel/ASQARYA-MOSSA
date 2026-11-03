import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {title:'بدلات المؤسسة | IN & OUT',description:'تنظيم بدلات المؤسسة العسكرية وموافقة مدير المبيعات'};
export default function RootLayout({children}:{children:React.ReactNode}) {return <html lang="ar" dir="rtl"><body>{children}</body></html>}
