import sqlite3
db=sqlite3.connect(':memory:')
db.executescript("CREATE TABLE r(id TEXT PRIMARY KEY, version INTEGER, token TEXT);CREATE TABLE backup(id TEXT PRIMARY KEY, first_record TEXT, second_record TEXT);CREATE TABLE keys(key TEXT PRIMARY KEY, gid TEXT); INSERT INTO r VALUES('a',1,'old'); INSERT INTO r VALUES('b',2,'old'); INSERT INTO keys VALUES('100','a');INSERT INTO keys VALUES('101','b');")
def merge(conflict=False):
 with db:
  db.execute("INSERT INTO backup SELECT 'bk','original-a','original-b' WHERE EXISTS(SELECT 1 FROM r WHERE id='a' AND version=1) AND EXISTS(SELECT 1 FROM r WHERE id='b' AND version=2)")
  db.execute("UPDATE r SET version=2,token='new' WHERE id='a' AND version=1 AND EXISTS(SELECT 1 FROM r WHERE id='b' AND version=2)")
  db.execute("DELETE FROM keys WHERE gid IN ('a','b') AND EXISTS(SELECT 1 FROM r WHERE id='a' AND token='new')")
  db.execute("DELETE FROM r WHERE id='b' AND version=2 AND EXISTS(SELECT 1 FROM r WHERE id='a' AND token='new')")
  db.execute("INSERT INTO keys SELECT '100','a' WHERE EXISTS(SELECT 1 FROM r WHERE id='a' AND token='new')")
  if conflict: db.execute("INSERT INTO keys VALUES('100','other')")
  db.execute("INSERT INTO keys SELECT '101','a' WHERE EXISTS(SELECT 1 FROM r WHERE id='a' AND token='new')")
try: merge(True)
except sqlite3.IntegrityError: pass
assert db.execute('SELECT COUNT(*) FROM r').fetchone()[0]==2
assert db.execute('SELECT COUNT(*) FROM backup').fetchone()[0]==0
merge()
assert db.execute('SELECT COUNT(*) FROM r').fetchone()[0]==1
assert db.execute('SELECT COUNT(*) FROM backup').fetchone()[0]==1
assert db.execute("SELECT COUNT(*) FROM keys WHERE gid='a'").fetchone()[0]==2
print('PASS: transaction rollback on conflict, archive and merged keys')
