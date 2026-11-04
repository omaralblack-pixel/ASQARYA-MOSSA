import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {title:'إدارة المؤسسة | مركز الكيلاني',description:'مساحة عمل المؤسسة: البدلات ومطابقة الفواتير ومراجعة ترحيلات آخر الشهر'};
export default function RootLayout({children}:{children:React.ReactNode}) {return <html lang="ar" dir="rtl"><body>{children}</body></html>}
