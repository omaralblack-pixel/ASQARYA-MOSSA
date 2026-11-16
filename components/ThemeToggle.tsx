import {Moon,Sun} from 'lucide-react';

export default function ThemeToggle(){
  return <button type="button" className="theme-toggle no-print" data-theme-toggle
    aria-label="تبديل الوضع الليلي والنهاري" title="تبديل الوضع الليلي والنهاري">
    <Moon size={17} className="theme-dark-action" aria-hidden="true"/>
    <Sun size={17} className="theme-light-action" aria-hidden="true"/>
    <span className="theme-dark-action">الوضع الليلي</span>
    <span className="theme-light-action">الوضع النهاري</span>
  </button>;
}
