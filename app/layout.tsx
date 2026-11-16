import type { Metadata } from 'next';
import './globals.css';
import './theme.css';
import {themeRuntimeScript} from '../lib/theme';
export const metadata: Metadata = {title:'إدارة المؤسسة | مركز الكيلاني',description:'مساحة عمل المؤسسة: البدلات ومطابقة الفواتير ومراجعة ترحيلات آخر الشهر'};
export default function RootLayout({children}:{children:React.ReactNode}) {return <html lang="ar" dir="rtl" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{__html:themeRuntimeScript}}/></head><body>{children}</body></html>}
