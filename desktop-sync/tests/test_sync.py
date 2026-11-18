import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from sync_core import Api, Outbox, StableWatcher, SyncError, decode_txt, saved_file, sync_one, validate_origin

ORIGIN='https://example.test'

class Tests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.folder=self.root/'SAP';self.folder.mkdir()
        self.outbox=Outbox(self.root/'state')
        self.source=self.folder/'SAP.txt'

    def test_stable_save_and_new_daily_same_name(self):
        watcher=StableWatcher(self.outbox,quiet_seconds=8)
        self.source.write_bytes(b'A')
        self.assertEqual(watcher.scan(self.folder,ORIGIN,0)[0],[])
        self.source.write_bytes(b'First complete daily version')
        self.assertEqual(watcher.scan(self.folder,ORIGIN,6)[0],[])
        self.assertEqual(watcher.scan(self.folder,ORIGIN,13)[0],[])
        self.assertEqual(len(watcher.scan(self.folder,ORIGIN,14)[0]),1)
        old=self.outbox.rows(ORIGIN)[0]
        self.source.write_bytes(b'Second complete daily version')
        watcher.scan(self.folder,ORIGIN,15)
        self.assertEqual(len(watcher.scan(self.folder,ORIGIN,23)[0]),1)
        rows=self.outbox.rows(ORIGIN)
        self.assertEqual(len(rows),2)
        self.assertNotEqual(rows[0]['sha'],rows[1]['sha'])
        self.assertEqual(self.outbox.bytes(old['sha']),b'First complete daily version')
        self.assertTrue(self.source.exists())
        self.source.rename(self.folder/'renamed.txt')
        watcher.scan(self.folder,ORIGIN,24);watcher.scan(self.folder,ORIGIN,32)
        self.assertEqual(len(self.outbox.rows(ORIGIN)),2)
        self.assertEqual(len(Outbox(self.root/'state').rows(ORIGIN)),2)

    def test_crash_between_snapshot_and_database_commit(self):
        self.source.write_bytes(b'preserve me')
        self.outbox.capture(self.source,ORIGIN)
        with self.outbox.db() as db:db.execute('DELETE FROM files')
        self.source.write_bytes(b'overwritten on desktop')
        recovered=Outbox(self.root/'state')
        self.assertEqual(len(recovered.rows(ORIGIN)),1)
        self.assertEqual(recovered.bytes(recovered.rows(ORIGIN)[0]['sha']),b'preserve me')

    def test_incomplete_snapshot_not_enqueued(self):
        self.source.write_bytes(b'SAP')
        with patch('sync_core.saved_file',side_effect=PermissionError('still saving')):
            watcher=StableWatcher(self.outbox,0)
            watcher.scan(self.folder,ORIGIN,0);watcher.scan(self.folder,ORIGIN,1)
        self.assertEqual(self.outbox.rows(ORIGIN),[])

    def test_failure_and_lost_server_response_resume_only_pending(self):
        self.source.write_bytes(b'header\nrow')
        self.outbox.capture(self.source,ORIGIN)
        class Fake:
            def __init__(self):self.fail_upload=True;self.fail_batch=True;self.done=False;self.calls=[]
            def call(self,query='',body=None,raw=None,name=None):
                if raw is not None:
                    if self.fail_upload:self.fail_upload=False;raise SyncError('HTTP 502')
                    return dict(sha256=hashlib.sha256(raw).hexdigest(),key='immutable')
                if body:
                    self.calls.append(body)
                    if body['action']=='batch':
                        self.assert_index=body['index'];self.done=True
                        if self.fail_batch:self.fail_batch=False;raise SyncError('connection lost AFTER commit')
                    if body['action']=='publish':return {'published':True,'review':['review note']}
                return {'file':{'published':False},'job':{'batches':[{'idx':0,'state':'complete'},{'idx':1,'state':'complete' if self.done else 'pending'}]}}
        api=Fake()
        def step():return sync_one(self.outbox,api,self.outbox.rows(ORIGIN)[0])
        with self.assertRaises(SyncError):step()
        self.assertEqual(self.outbox.rows(ORIGIN)[0]['stage'],'upload')
        step()
        with self.assertRaises(SyncError):step()
        # Fresh process reads durable status, does NOT rerun successful batch 1.
        self.outbox=Outbox(self.root/'state');step()
        self.assertEqual(self.outbox.rows(ORIGIN)[0]['stage'],'done')
        self.assertEqual([c['index'] for c in api.calls if c['action']=='batch'],[1])
        self.assertTrue(self.source.exists())
        self.assertEqual(self.outbox.rows(ORIGIN)[0]['review'],'review note')

    def test_credentials_expired_block_without_deleting(self):
        self.source.write_bytes(b'A');self.outbox.capture(self.source,ORIGIN)
        class Fake:
            def call(self,*args,**kwargs):raise SyncError('HTTP 401',False)
        with self.assertRaises(SyncError):sync_one(self.outbox,Fake(),self.outbox.rows(ORIGIN)[0])
        self.assertEqual(self.outbox.rows(ORIGIN)[0]['stage'],'blocked')
        self.outbox.retry_blocked(ORIGIN)
        self.assertEqual(self.outbox.rows(ORIGIN)[0]['stage'],'upload')
        self.assertTrue(self.outbox.bytes(self.outbox.rows(ORIGIN)[0]['sha']))

    def test_network_502_html_does_not_parse_as_success(self):
        import io
        import urllib.error
        api=Api(ORIGIN,'sapds_'+'a'*64)
        error=urllib.error.HTTPError(ORIGIN,502,'Bad gateway',{},io.BytesIO(b'<html>cloudflare</html>'))
        with patch.object(api.opener,'open',side_effect=error):
            with self.assertRaises(SyncError) as ctx:api.call()
        self.assertTrue(ctx.exception.retry)
        self.assertIn('502',str(ctx.exception))
        self.assertNotIn('cloudflare',str(ctx.exception))

    def test_encoding_and_origin_and_corruption(self):
        for encoding in ('utf-8-sig','utf-16'):
            self.assertEqual(decode_txt('اسم\tكمية'.encode(encoding)),'اسم\tكمية')
        for origin in ('http://example.test','https://user:pass@example.test','https://example.test/path'):
            with self.assertRaises(ValueError):validate_origin(origin)
        self.source.write_bytes(b'original');sha=self.outbox.capture(self.source,ORIGIN)
        snapshot=next(self.outbox.spool.glob('*-'+sha+'.snapshot'))
        metadata=snapshot.read_bytes().split(b'\n',1)[0]
        snapshot.write_bytes(metadata+b'\ncorruption')
        with self.assertRaises(SyncError):Outbox(self.root/'state')

    @unittest.skipUnless(os.name=='nt','Windows file sharing and DPAPI')
    def test_windows_exclusive_copy_and_dpapi(self):
        from windows_secrets import protect
        secret=b'sapds_'+b'a'*64
        encrypted=protect(secret)
        self.assertNotIn(secret,encrypted)
        self.assertEqual(protect(encrypted,True),secret)
        self.source.write_bytes(b'bytes')
        with open(self.source,'wb') as writer:
            writer.write(b'SAP is writing');writer.flush()
            with self.assertRaises(OSError):
                with saved_file(self.source):pass

if __name__=='__main__':unittest.main()
