import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { Product } from '../data/catalog';
import assets from '../data/assets.json';

type Props = {
  label: string;
  selected: Product;
  options: Product[];
  disabled: boolean;
  onChange: (id: string) => void;
};

function Thumbnail({ product }: { product: Product }) {
  const asset = assets[product.image as keyof typeof assets];
  return <img className="sticker-select-image" src={asset.variants[0].src} width={asset.width} height={asset.height} alt="" decoding="async" />;
}

export default function StickerSelect({ label, selected, options, disabled, onChange }: Props) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const expanded = open && !disabled && options.length > 0;

  useEffect(() => {
    if (!expanded) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [expanded]);

  useEffect(() => {
    if (expanded) document.getElementById(`${id}-option-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [expanded, active, id]);

  function show() {
    setActive(Math.max(0, options.findIndex(option => option.id === selected.id)));
    setOpen(true);
  }

  function choose(index: number) {
    if (!options[index]) return;
    onChange(options[index].id);
    setOpen(false);
    trigger.current?.focus();
  }

  function handleKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!expanded) { show(); return; }
      setActive(index => event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 :
        (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (expanded) choose(active); else show();
    } else if (event.key === 'Escape') {
      if (expanded) event.preventDefault();
      setOpen(false);
    } else if (event.key === 'Tab') setOpen(false);
  }

  return <div className="sticker-select" ref={root} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }}>
    <span className="sticker-select-label" id={`${id}-label`}>{label}</span>
    <button ref={trigger} type="button" className="sticker-select-trigger" role="combobox"
      aria-labelledby={`${id}-label`} aria-describedby={`${id}-value`} aria-haspopup="listbox" aria-expanded={expanded}
      aria-controls={`${id}-listbox`} aria-activedescendant={expanded ? `${id}-option-${active}` : undefined}
      disabled={disabled || options.length === 0} onKeyDown={handleKey} onClick={() => expanded ? setOpen(false) : show()}>
      <Thumbnail product={selected} /><span id={`${id}-value`}>{selected.name}</span><ChevronDown size={16} aria-hidden="true" />
    </button>
    {expanded && <ul className="sticker-select-menu" id={`${id}-listbox`} role="listbox" aria-labelledby={`${id}-label`}>
      {options.map((option, index) => <li key={option.id} id={`${id}-option-${index}`} role="option"
        aria-selected={option.id === selected.id} className={active === index ? 'is-active' : ''}
        onPointerMove={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}>
        <Thumbnail product={option} /><span>{option.name}</span>{option.id === selected.id && <Check size={16} aria-hidden="true" />}
      </li>)}
    </ul>}
  </div>;
}
