"""Durable SAP TXT outbox. Standard library only; no embedded server secrets."""
from __future__ import annotations
import contextlib
import hashlib
import json
import os
from pathlib import Path
import random
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
from unified_chunks import unified_chunks, MAX_CHUNK_BYTES

MAX_BYTES = 16 * 1024 * 1024

class SyncError(Exception):
    def __init__(self, message, retry=True):
        super().__init__(message)
        self.retry = retry


def validate_origin(value):
    u = urllib.parse.urlsplit(value.strip())
    if u.scheme != 'https' or not u.hostname or u.username or u.password or u.query or u.fragment or u.path not in ('', '/'):
        raise ValueError('أدخل رابط الموقع HTTPS فقط، دون مسار أو كلمة سر.')
    return urllib.parse.urlunsplit(('https', u.netloc, '', '', ''))


def atomic_write(path, data):
    temp = path.with_suffix(path.suffix + '.tmp')
    with open(temp, 'wb') as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp, path)


@contextlib.contextmanager
def saved_file(path):
    """On Windows reject files still open for writing and deny writes while copying."""
    if os.name != 'nt':
        with open(path, 'rb') as f:
            yield f
        return
    import ctypes
    from ctypes import wintypes
    import msvcrt
    k = ctypes.WinDLL('kernel32', use_last_error=True)
    k.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    k.CreateFileW.restype = wintypes.HANDLE
    handle = k.CreateFileW(str(path), 0x80000000, 1, None, 3, 0x80, None)
    if handle == wintypes.HANDLE(-1).value:
        raise OSError(ctypes.get_last_error(), 'SAP is still saving or file unavailable')
    fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
    with os.fdopen(fd, 'rb') as f:
        yield f


class Outbox:
    def __init__(self, root):
        self.root = Path(root)
        self.spool = self.root / 'outbox'
        self.spool.mkdir(parents=True, exist_ok=True)
        self.db_path = self.root / 'queue.sqlite3'
        with self.db() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE IF NOT EXISTS files (origin TEXT NOT NULL,sha TEXT NOT NULL,name TEXT NOT NULL,stage TEXT NOT NULL DEFAULT "upload",key TEXT,attempts INTEGER NOT NULL DEFAULT 0,next REAL NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT "",review TEXT NOT NULL DEFAULT "",created REAL NOT NULL,saved_at INTEGER NOT NULL DEFAULT 0,is_chunk INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(origin,sha))')
            if 'saved_at' not in [r[1] for r in db.execute('PRAGMA table_info(files)')]:
                db.execute('ALTER TABLE files ADD COLUMN saved_at INTEGER NOT NULL DEFAULT 0')
                db.execute('UPDATE files SET saved_at=CAST(created*1000 AS INTEGER)')
            if 'is_chunk' not in [r[1] for r in db.execute('PRAGMA table_info(files)')]:
                db.execute('ALTER TABLE files ADD COLUMN is_chunk INTEGER NOT NULL DEFAULT 0')
        self.recover()

    @contextlib.contextmanager
    def db(self):
        db = sqlite3.connect(self.db_path, timeout=20)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA synchronous=FULL')
        try:
            with db:
                yield db
        finally:
            db.close()

    def recover(self):
        # Manifests are durable before queue insertion. Recover a crash between
        # snapshot creation and SQLite commit, even if the source was overwritten.
        for path in self.spool.glob('*.snapshot'):
            with open(path,'rb') as f:
                meta = json.loads(f.readline(8192).decode('utf-8'))
                data = f.read(MAX_BYTES+1)
            if not 0 < len(data) <= MAX_BYTES or hashlib.sha256(data).hexdigest() != meta['sha']:
                raise SyncError('تلف في نسخة محلية؛ احتفظ بمجلد البرنامج وراجع السجل.', False)
            with self.db() as db:
                db.execute('INSERT OR IGNORE INTO files(origin,sha,name,created,saved_at,is_chunk) VALUES(?,?,?,?,?,?)',
                           (meta['origin'], meta['sha'], meta['name'], meta['created'], meta.get('saved_at',int(meta['created']*1000)),int(meta.get('is_chunk',False))))

    def capture(self, path, origin):
        path = Path(path)
        before = path.stat()
        if not 0 < before.st_size <= MAX_BYTES:
            raise SyncError('الملف فارغ أو يتجاوز 16 MiB: ' + path.name, False)
        with saved_file(path) as f:
            data = f.read(MAX_BYTES + 1)
            after = path.stat()
            if (before.st_mtime_ns, before.st_size) != (after.st_mtime_ns, after.st_size) or len(data) != before.st_size:
                return None
        return self.enqueue(data,path.name,origin,int(before.st_mtime*1000))

    def enqueue(self,data,name,origin,saved_at,is_chunk=False):
        sha = hashlib.sha256(data).hexdigest()
        with self.db() as db:
            if db.execute('SELECT 1 FROM files WHERE origin=? AND sha=?', (origin, sha)).fetchone():
                return None
        # Metadata and original bytes share ONE atomic file. There is no crash
        # window with durable bytes but no recoverable name/destination.
        destination = hashlib.sha256(origin.encode()).hexdigest()[:16]
        meta = dict(origin=origin, sha=sha, name=name, created=time.time(), saved_at=saved_at,is_chunk=is_chunk)
        snapshot = self.spool / (destination + '-' + sha + '.snapshot')
        atomic_write(snapshot, json.dumps(meta, ensure_ascii=False).encode()+b'\n'+data)
        with self.db() as db:
            db.execute('INSERT OR IGNORE INTO files(origin,sha,name,created,saved_at,is_chunk) VALUES(?,?,?,?,?,?)',
                       (origin, sha, name, meta['created'],meta['saved_at'],int(is_chunk)))
        return sha

    def bytes(self, sha):
        path = next(self.spool.glob('*-' + sha + '.snapshot'))
        with open(path,'rb') as f:
            f.readline(8192)
            return f.read(MAX_BYTES+1)

    def update(self, origin, sha, **values):
        if not values.keys() <= {'stage','key','attempts','next','error','review'}:
            raise ValueError('Invalid field')
        with self.db() as db:
            db.execute('UPDATE files SET ' + ','.join(k + '=?' for k in values) + ' WHERE origin=? AND sha=?',
                       (*values.values(), origin, sha))

    def rows(self, origin):
        with self.db() as db:
            return [dict(r) for r in db.execute('SELECT * FROM files WHERE origin=? ORDER BY created', (origin,))]

    def retry_blocked(self, origin):
        with self.db() as db:
            db.execute('UPDATE files SET next=0,error="",stage=CASE WHEN key IS NULL THEN "upload" ELSE "process" END WHERE origin=? AND stage="blocked"', (origin,))


class StableWatcher:
    def __init__(self, outbox, quiet_seconds=8):
        self.outbox, self.quiet = outbox, quiet_seconds
        self.observed = {}

    def scan(self, folder, origin, now=None):
        now = time.monotonic() if now is None else now
        captured, errors, present = [], [], set()
        for path in sorted(Path(folder).iterdir()):
            if path.suffix.lower() != '.txt' or not path.is_file() or path.is_symlink():
                continue
            present.add(path)
            try:
                st = path.stat()
                sig = (st.st_size, st.st_mtime_ns)
                old = self.observed.get(path)
                if old is None or old[0] != sig:
                    self.observed[path] = (sig, now, False)
                    continue
                if old[2] or now - old[1] < self.quiet:
                    continue
                sha = self.outbox.capture(path, origin)
                self.observed[path] = (sig, old[1], True)
                if sha:
                    captured.append((path.name, sha))
            except OSError:
                # Locked/in-progress writes are retried on the next scan.
                continue
            except SyncError as e:
                errors.append(str(e))
                self.observed[path] = (sig, now, True)
        self.observed = {p:v for p,v in self.observed.items() if p in present}
        return captured, errors


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward the device credential to login, a proxy or another host.
        raise SyncError('الموقع أعاد توجيهًا؛ تحقق من رابط الموقع وربط الجهاز.', False)


class Api:
    def __init__(self, origin, token):
        self.origin, self.token = validate_origin(origin), token
        if not token.startswith('sapds_') or len(token) != 70:
            raise ValueError('رمز الجهاز غير صالح.')
        self.opener = urllib.request.build_opener(NoRedirect)

    def call(self, query='', body=None, raw=None, name=None, saved_at=None):
        headers = {'Authorization':'Bearer '+self.token, 'Accept':'application/json'}
        if raw is not None:
            headers.update({'Content-Type':'application/octet-stream','X-File-Name':urllib.parse.quote(name),'X-SAP-Saved-At':str(saved_at)})
            data = raw
        elif body is not None:
            headers['Content-Type'] = 'application/json'
            data = json.dumps(body, ensure_ascii=False).encode('utf-8')
        else:
            data = None
        req = urllib.request.Request(self.origin + '/api/desktop-sync' + query, data=data, headers=headers)
        try:
            with self.opener.open(req, timeout=90) as res:
                value = json.load(res)
                if not isinstance(value, dict):
                    raise SyncError('رد الخادم ليس كائن JSON صالحًا.')
                return value
        except urllib.error.HTTPError as e:
            # Retain a bounded JSON error, never an HTML edge page or credential.
            detail = 'HTTP ' + str(e.code)
            try:
                message = json.loads(e.read(4096)).get('error')
                if isinstance(message, str):
                    detail += ': ' + message[:500]
            except (ValueError, AttributeError):
                pass
            raise SyncError(detail, e.code in (408,409,425,429) or e.code >= 500) from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
            raise SyncError('انقطاع اتصال أو رد JSON غير مكتمل؛ ستعاد المحاولة.') from e


def decode_txt(data):
    if data.startswith((b'\xff\xfe', b'\xfe\xff')):
        return data.decode('utf-16').lstrip('\ufeff')
    return data.decode('utf-8-sig')


def sync_one(outbox, api, row):
    """One durable network step. Each retry reads server progress before claiming work."""
    sha, origin = row['sha'], row['origin']
    query = '?sha256=' + sha
    try:
        if row['stage'] == 'upload':
            data = outbox.bytes(sha)
            if hashlib.sha256(data).hexdigest() != sha:
                raise SyncError('بصمة النسخة المحلية غير متطابقة.', False)
            result = api.call(query+'&action=upload', raw=data, name=row['name'], saved_at=row['saved_at'])
            if result.get('sha256') != sha or not result.get('key'):
                raise SyncError('الخادم لم يؤكد بصمة الملف ومفتاح الأرشيف.')
            outbox.update(origin, sha, stage='process', key=result['key'], attempts=0, next=0, error='')
            return
        state = api.call(query)
        if not state.get('file'):
            outbox.update(origin, sha, stage='upload', next=0)
            return
        if state['file'].get('published'):
            job = state.get('job') or {}
            outbox.update(origin, sha, stage='done', attempts=0, next=0, error='', review='؛ '.join(job.get('issues',[]) or state['file'].get('review',[])))
            return
        job = state.get('job')
        data=outbox.bytes(sha)
        if not job and not row.get('is_chunk') and len(data)>MAX_CHUNK_BYTES:
            try:
                text=decode_txt(data)
                children=unified_chunks(text)
            except (ValueError,UnicodeError) as e:
                raise SyncError(str(e),False)
            if 'RecordType' in text.split('\n')[0].split('\t'):
                hashes=[]
                for i,child in enumerate(children):
                    child_bytes=child.encode()
                    child_sha=hashlib.sha256(child_bytes).hexdigest();hashes.append(child_sha)
                    outbox.enqueue(child_bytes,'sap-'+sha[:16]+'-'+str(i+1).zfill(4)+'.txt',origin,row['saved_at'],True)
                statuses={r['sha']:r['stage'] for r in outbox.rows(origin)}
                if all(statuses.get(h)=='done' for h in hashes):
                    result=api.call(query,body={'action':'publish','chunks':hashes})
                    if not result.get('published'):raise SyncError('لم يؤكد الخادم اكتمال جميع أجزاء الأصل.')
                    outbox.update(origin,sha,stage='done',next=0,error='',review='؛ '.join(result.get('review',[])))
                else:
                    outbox.update(origin,sha,next=time.time()+3,error='استكمال أجزاء SAP الصغيرة؛ الأصل والدفعات السابقة محفوظة.')
                return
        if not job:
            try:
                text = decode_txt(data)
            except UnicodeError:
                raise SyncError('الأصل مؤرشف، لكن ترميز TXT غير مدعوم. استخدم UTF-8 أو UTF-16 وراجع ملفات SAP.', False)
            result = api.call(query, body={'action':'start','text':text})
            if not result.get('job'):
                raise SyncError('الخادم لم يؤكد خطة المعالجة.')
        else:
            pending = next((b for b in job['batches'] if b['state'] != 'complete'), None)
            if pending:
                result = api.call(query, body={'action':'batch','index':pending['idx']})
                updated = result.get('job')
                if not updated:
                    raise SyncError('الخادم لم يؤكد حالة الدفعة.')
                if result.get('busy'):
                    raise SyncError('دفعة قيد التنفيذ؛ انتظار انتهاء مهلة الحجز.')
                failed = next((b for b in updated['batches'] if b['idx']==pending['idx'] and b['state']=='failed'), None)
                if failed:
                    raise SyncError(failed.get('error') or 'فشلت دفعة SAP؛ الدفعات السابقة محفوظة.')
            else:
                if row.get('is_chunk'):
                    outbox.update(origin,sha,stage='done',next=0,error='',review='؛ '.join(job.get('issues',[])))
                    return
                result = api.call(query, body={'action':'publish'})
                if not result.get('published'):
                    raise SyncError('لم يُؤكد تحديث مصادر SAP المشتركة.')
                outbox.update(origin, sha, stage='done', attempts=0, next=0, error='', review='؛ '.join(result.get('review',[])))
                return
        outbox.update(origin, sha, attempts=0, next=0, error='')
    except SyncError as e:
        attempts = row['attempts'] + 1
        delay = min(900, 2**min(attempts,9)) + random.uniform(0,3)
        outbox.update(origin, sha, stage=row['stage'] if e.retry else 'blocked', attempts=attempts,
                      next=time.time()+delay, error=str(e))
        raise
