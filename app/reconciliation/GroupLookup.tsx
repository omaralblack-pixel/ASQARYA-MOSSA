'use client';

import {useId} from 'react';
import {Combobox} from '@base-ui/react';
import {digits} from '../lib/reconcile';

function normalize(value: string) {
  return digits(value).trim().replace(/[أإآٱ]/g, 'ا').replace(/[\u064B-\u065F\u0670ـ]/g, '');
}

export default function GroupLookup({label, placeholder, items, value, onChange, required}: {
  label: string;
  placeholder: string;
  items: string[];
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  const id = useId();
  return <div className="group-lookup">
    <label htmlFor={id}>{label}{required&&<> <em>*</em></>}</label>
    <Combobox.Root items={items} value={value||null} onValueChange={item=>onChange(item||'')}
      filter={(item, query)=>normalize(item).includes(normalize(query))} autoHighlight>
      <div className="group-lookup-field">
        <Combobox.Input id={id} placeholder={placeholder} aria-required={required}/>
        <Combobox.Clear className="group-lookup-clear" aria-label={'مسح '+label}>×</Combobox.Clear>
      </div>
      <Combobox.Positioner className="group-lookup-position" sideOffset={4}>
        <Combobox.Popup className="group-lookup-popup">
          <Combobox.Empty className="group-lookup-empty">ما في أسماء مطابقة</Combobox.Empty>
          <Combobox.List className="group-lookup-list">
            {(item: string)=><Combobox.Item key={item} value={item} className="group-lookup-item">{item}</Combobox.Item>}
          </Combobox.List>
        </Combobox.Popup>
      </Combobox.Positioner>
    </Combobox.Root>
  </div>;
}
