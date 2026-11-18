"""The byte-level raw chunk contract in app/lib/sap-desktop-chunks.ts."""
MAX_CHUNK_BYTES=280000

def unified_chunks(text,max_bytes=MAX_CHUNK_BYTES):
    lines=[line for line in text.lstrip('\ufeff').replace('\r','').split('\n') if line.strip()]
    if not lines:return []
    header=lines.pop(0);columns=header.split('\t')
    if 'RecordType' not in columns:return []
    def idx(name):
        if name not in columns:raise ValueError('Missing unified SAP column: '+name)
        return columns.index(name)
    kind,number,doctype,entry=map(idx,['RecordType','DocumentNumber','DocumentType','DocEntry'])
    windows=[line for line in lines if line.split('\t')[kind]=='WINDOW']
    if len(windows)!=1:raise ValueError('Unified source must contain one WINDOW row')
    prefix=header+'\n'+windows[0]
    groups={}
    for i,line in enumerate(lines):
        cells=line.split('\t')
        if len(cells)!=len(columns):raise ValueError('Invalid unified SAP row '+str(i+2))
        k=cells[kind]
        if k not in ('WINDOW','TRANSFER','OFFICIAL','OPENING','CLOSING','OINM'):raise ValueError('Invalid unified SAP row '+str(i+2))
        # Stock stays whole in the parent, avoiding partial-balance evidence.
        if k in ('WINDOW','OPENING','CLOSING'):continue
        key=k+':'+cells[number] if k=='TRANSFER' else k+':'+cells[doctype]+'|'+cells[entry] if k=='OFFICIAL' else k+':'+str(i)
        groups.setdefault(key,[]).append(line)
    chunks=[];chunk=prefix;prefix_size=len(prefix.encode());chunk_size=prefix_size
    for group in groups.values():
        body='\n'+'\n'.join(group)
        body_size=len(body.encode())
        if prefix_size+body_size>max_bytes:raise ValueError('مستند SAP واحد أكبر من حد الجزء الآمن؛ الأصل محفوظ للمراجعة.')
        if chunk_size+body_size>max_bytes:
            chunks.append(chunk);chunk=prefix;chunk_size=prefix_size
        chunk+=body;chunk_size+=body_size
    if chunk!=prefix:chunks.append(chunk)
    return chunks
