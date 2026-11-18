import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import queue
import sys
import threading
import time
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
import webbrowser
from sync_core import Api, Outbox, StableWatcher, SyncError, atomic_write, sync_one, validate_origin
from windows_secrets import protect

ROOT = Path(os.environ.get('LOCALAPPDATA', Path.home())) / 'SAPDesktopSync'
ROOT.mkdir(parents=True, exist_ok=True)
log = logging.getLogger('sap-sync')
log.setLevel(logging.INFO)
handler = RotatingFileHandler(ROOT/'sync.log', maxBytes=1024*1024, backupCount=5, encoding='utf-8')
handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(message)s'))
log.addHandler(handler)


def startup(enabled):
    import winreg
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, r'Software\Microsoft\Windows\CurrentVersion\Run') as key:
        if enabled:
            if not getattr(sys, 'frozen', False):
                raise ValueError('التشغيل مع Windows متاح بعد بناء EXE وتثبيته.')
            winreg.SetValueEx(key, 'SAPDesktopSync', 0, winreg.REG_SZ, '"'+sys.executable+'" --background')
        else:
            try:
                winreg.DeleteValue(key, 'SAPDesktopSync')
            except FileNotFoundError:
                pass


class App:
    def __init__(self, window):
        self.window, self.events = window, queue.Queue()
        self.stop = threading.Event()
        self.outbox = Outbox(ROOT)
        self.api = self.folder = None
        self.config_lock = threading.Lock()
        self.status = tk.StringVar(value='اختر مجلد TXT واربط الجهاز، ثم اضغط حفظ وتشغيل.')
        self.origin = tk.StringVar(value='https://asqarya-mossa.almqablen.workers.dev')
        self.path, self.token = tk.StringVar(), tk.StringVar()
        self.auto = tk.BooleanVar(value=False)
        window.title('SAP Desktop Sync')
        window.geometry('900x560')
        frame = ttk.Frame(window, padding=20)
        frame.pack(fill='both', expand=True)
        for label,var in [('رابط موقع المؤسسة',self.origin),('مجلد TXT',self.path),('رمز ربط الجهاز (مرة واحدة)',self.token)]:
            ttk.Label(frame,text=label).pack(anchor='e')
            ttk.Entry(frame,textvariable=var,show='*' if var is self.token else '').pack(fill='x',pady=4)
        bar=ttk.Frame(frame);bar.pack(fill='x',pady=8)
        ttk.Button(bar,text='اختيار مجلد',command=self.choose).pack(side='right',padx=4)
        ttk.Button(bar,text='فتح صفحة الربط',command=lambda:webbrowser.open(validate_origin(self.origin.get())+'/desktop-sync')).pack(side='right',padx=4)
        ttk.Button(bar,text='حفظ وتشغيل',command=self.save).pack(side='right',padx=4)
        ttk.Checkbutton(frame,text='تشغيل تلقائي عند دخولي إلى Windows',variable=self.auto).pack(anchor='e')
        ttk.Label(frame,textvariable=self.status,wraplength=840).pack(fill='x',pady=12)
        self.list = ttk.Treeview(frame,columns=('name','stage','info'),show='headings')
        for key,title,width in [('name','الملف',210),('stage','الحالة',130),('info','آخر نتيجة / ملاحظة',480)]:
            self.list.heading(key,text=title);self.list.column(key,width=width)
        self.list.pack(fill='both',expand=True)
        ttk.Button(frame,text='فتح السجل والنسخ المحلية',command=lambda:os.startfile(ROOT)).pack(anchor='e',pady=8)
        window.protocol('WM_DELETE_WINDOW',self.close)
        self.load()
        for work in (self.watch,self.upload):
            threading.Thread(target=work,daemon=True).start()
        window.after(500,self.refresh)
        if '--background' in sys.argv:
            window.after(200,window.iconify)

    def choose(self):
        value=filedialog.askdirectory(initialdir=self.path.get() or Path.home()/'Desktop')
        if value:self.path.set(value)

    def load(self):
        try:
            config=json.loads((ROOT/'config.json').read_text('utf-8'))
            token=protect((ROOT/'device.dpapi').read_bytes(),True).decode()
            self.origin.set(config['origin']);self.path.set(config['folder']);self.auto.set(config.get('startup',False))
            self.api,self.folder=Api(config['origin'],token),config['folder']
            self.status.set('المراقبة تعمل. اترك البرنامج مفتوحًا؛ التصغير إلى شريط المهام يستمر بالمزامنة.')
        except FileNotFoundError:pass
        except Exception:
            self.status.set('تعذّر فتح إعدادات الربط؛ أدخل رمز جهاز جديد ثم احفظ. الملفات المحلية محفوظة.')

    def save(self):
        try:
            origin=validate_origin(self.origin.get());folder=str(Path(self.path.get()).resolve())
            if not Path(folder).is_dir():raise ValueError('اختر مجلدًا موجودًا.')
            if Path(folder)==ROOT or ROOT in Path(folder).parents:raise ValueError('اختر مجلد SAP منفصلًا عن مجلد نسخ البرنامج.')
            token=self.token.get().strip()
            if not token:
                if self.api is None or self.api.origin!=origin:raise ValueError('ألصق رمز الربط من الموقع.')
                token=self.api.token
            api=Api(origin,token)
            # Connection check runs off the UI thread; credentials are persisted
            # only after the server confirms the intended device protocol.
            self.status.set('جارٍ التحقق من الربط…')
            threading.Thread(target=self.connect,args=(api,folder,self.auto.get()),daemon=True).start()
        except Exception as e:messagebox.showerror('SAP Desktop Sync',str(e))

    def connect(self,api,folder,auto):
        try:
            check=api.call()
            if check.get('protocol')!=1:raise ValueError('الموقع لا يدعم هذا الإصدار؛ انشر تحديث الخادم أولًا.')
            atomic_write(ROOT/'device.dpapi',protect(api.token.encode()))
            atomic_write(ROOT/'config.json',json.dumps(dict(origin=api.origin,folder=folder,startup=auto),ensure_ascii=False).encode())
            startup(auto)
            with self.config_lock:self.api,self.folder=api,folder
            self.outbox.retry_blocked(api.origin)
            self.events.put(('connected','تم الربط والتحقق منه. المراقبة تعمل.'))
        except Exception as e:self.events.put(('error',str(e)))

    def watch(self):
        watcher=None;previous=None
        while not self.stop.is_set():
            with self.config_lock:api,folder=self.api,self.folder
            if api and folder:
                try:
                    if previous!=(api.origin,folder):watcher=StableWatcher(self.outbox);previous=(api.origin,folder)
                    captured,errors=watcher.scan(folder,api.origin)
                    for name,sha in captured:
                        log.info('Captured sha256=%s',sha)
                        self.events.put(('status','حُفظت نسخة محلية وتنتظر الرفع: '+name))
                    for error in errors:self.events.put(('error',error))
                except Exception:
                    log.exception('Folder capture failed')
                    self.events.put(('error','تعذّرت قراءة المجلد أو الكتابة المحلية. راجع المساحة والصلاحيات.'))
            self.stop.wait(2)

    def upload(self):
        while not self.stop.is_set():
            with self.config_lock:api=self.api
            if api:
                try:
                    rows=self.outbox.rows(api.origin)
                    row=next((r for r in rows if r['stage'] not in ('done','blocked') and r['next']<=time.time()),None)
                    if row:
                        sync_one(self.outbox,api,row)
                except SyncError as e:
                    log.warning('Sync retry: %s',e)
                    self.events.put(('error',str(e)))
                except Exception:
                    log.exception('Local outbox error')
                    self.events.put(('error','تعذّر تشغيل الطابور؛ النسخ المحلية محفوظة. راجع السجل.'))
            self.stop.wait(1)

    def refresh(self):
        while True:
            try:
                kind,text=self.events.get_nowait();self.status.set(text)
                if kind=='connected':self.token.set('')
            except queue.Empty:break
        if self.api:
            names={'upload':'بانتظار الرفع','process':'أرشيف مؤكد / معالجة','done':'مكتمل','blocked':'تحتاج تدخلًا'}
            self.list.delete(*self.list.get_children())
            for r in self.outbox.rows(self.api.origin)[-100:]:
                self.list.insert('',0,values=(r['name'],names[r['stage']],r['error'] or r['review'] or r['sha'][:16]))
        self.window.after(1500,self.refresh)

    def close(self):
        if messagebox.askyesno('SAP Desktop Sync','إغلاق البرنامج يوقف المراقبة حتى تفتحه مجددًا. هل تريد إغلاقه؟ (يمكنك تصغيره بدل الإغلاق)'):
            self.stop.set();self.window.destroy()


if __name__=='__main__':
    if os.name!='nt':raise SystemExit('The desktop UI requires Windows.')
    if '--self-test' in sys.argv:
        import tempfile
        from sync_core import decode_txt
        assert protect(protect(b'build-smoke'), True)==b'build-smoke'
        assert decode_txt('اسم'.encode('utf-16'))=='اسم'
        with tempfile.TemporaryDirectory() as temp:
            assert Outbox(temp).rows('https://example.test')==[]
        raise SystemExit(0)
    # Per-user singleton prevents two watcher processes racing local snapshots.
    import ctypes
    k=ctypes.WinDLL('kernel32',use_last_error=True)
    k.CreateMutexW.argtypes=[ctypes.c_void_p,ctypes.c_bool,ctypes.c_wchar_p]
    k.CreateMutexW.restype=ctypes.c_void_p
    mutex=k.CreateMutexW(None,False,'Local\\SAPDesktopSync')
    if ctypes.get_last_error()==183:raise SystemExit('SAP Desktop Sync is already running; restore it from the taskbar.')
    window=tk.Tk()
    try:
        App(window);window.mainloop()
    except Exception as e:
        log.exception('Startup failed');messagebox.showerror('SAP Desktop Sync','تعذّر بدء البرنامج. راجع '+str(ROOT/'sync.log'))
