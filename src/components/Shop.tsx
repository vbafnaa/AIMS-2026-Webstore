import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUpRight, MapPin, Plus, ShoppingBag } from 'lucide-react';
import { catalog, money, type Product } from '../data/catalog';
import imageData from '../data/assets.json';
import StickerSelect from './StickerSelect';
import { isEarlyBird, priceAt } from '../lib/pricing';

type Single = { kind: 'single'; product_id: string; quantity: number; size: string };
type Pack = { kind: 'bundle'; size: 3 | 5; items: { product_id: string; quantity: number }[] };
type Line = Single | Pack;
type Settings = { pickup_address: string; orders_open: boolean; bundle_three_cents: number; bundle_five_cents: number };
type Attempt = { key: string; email: string; lines: Line[]; expected_total_cents: number };
type Receipt = { id: string; total_cents: number; pickup_address: string; status: string; lines: { name: string; size?: string; quantity: number; total_cents: number; preorder: boolean }[] };
type Asset = { src: string; width: number; height: number; variants: { src: string; width: number }[] };
const assets = imageData as Record<string, Asset>;
const storageKey = 'aims-pending-checkout';
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const validEmail = (value: string) => value.trim().length <= 254 && emailPattern.test(value.trim());
const defaults: Settings = { pickup_address: '', orders_open: false, bundle_three_cents: 399, bundle_five_cents: 999 };

function ProductImage({ name, alt, eager = false }: { name: string; alt: string; eager?: boolean }) {
  const asset = assets[name];
  return <img src={asset.src} srcSet={asset.variants.map(v => `${v.src} ${v.width}w`).join(', ')} sizes="(max-width: 640px) 44vw, (max-width: 1100px) 30vw, 280px" width={asset.width} height={asset.height} alt={alt} loading={eager ? 'eager' : 'lazy'} decoding="async" />;
}

export default function Shop({ url, apiKey, initialEpoch }: { url: string; apiKey: string; initialEpoch: number }) {
  const [epoch, setEpoch] = useState(initialEpoch);
  const [clockOffset, setClockOffset] = useState(0);
  const [products, setProducts] = useState<Product[]>(catalog);
  const [settings, setSettings] = useState<Settings>(defaults);
  const [category, setCategory] = useState('all');
  const [lines, setLines] = useState<Line[]>([]);
  const [sizes, setSizes] = useState<Record<string, string>>({ crewneck: 'M' });
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<Attempt | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [packSize, setPackSize] = useState<3 | 5>(3);
  const [packChoices, setPackChoices] = useState(['sticker-1', 'sticker-2', 'sticker-3', 'sticker-4', 'sticker-5']);
  const configured = Boolean(url && apiKey);
  const locked = busy || Boolean(pending);
  const ready = configured && loaded && settings.orders_open && Boolean(settings.pickup_address);

  async function refresh() {
    if (!configured) return;
    try {
      const headers = { apikey: apiKey };
      const responses = await Promise.all([
        fetch(`${url}/rest/v1/products?select=*&active=eq.true`, { headers, cache: 'no-store', signal: AbortSignal.timeout(10000) }),
        fetch(`${url}/rest/v1/shop_settings?select=*&id=eq.true`, { headers, cache: 'no-store', signal: AbortSignal.timeout(10000) }),
      ]);
      if (responses.some(r => !r.ok)) throw new Error();
      const [rows, config] = await Promise.all(responses.map(r => r.json()));
      if (!config[0]) throw new Error();
      setProducts(catalog.map(p => {
        const row = rows.find((r: Product) => r.id === p.id);
        return row ? { ...p, ...row, early_bird_price_cents: row.early_bird_price_cents ?? null, early_bird_ends_at_epoch: row.early_bird_ends_at_epoch ?? null } : { ...p, active: false };
      }));
      setSettings(config[0]);
      setLoaded(true);
    } catch {
      setLoaded(false);
      setError('Availability could not be loaded. Refresh availability before ordering.');
    }
  }

  useEffect(() => {
    void refresh();
    try {
      const saved = sessionStorage.getItem(storageKey);
      if (saved) {
        const attempt: Attempt = JSON.parse(saved);
        if (typeof attempt.key === 'string' && typeof attempt.email === 'string' && Array.isArray(attempt.lines)) {
          setPending(attempt); setLines(attempt.lines); setEmail(attempt.email);
          setError('A previous checkout needs confirmation. Retry it safely below before making another order.');
        }
      }
    } catch { /* Submission checks whether safe retry storage is available. */ }
  }, []);

  useEffect(() => { if (receipt) document.getElementById('order-confirmation')?.focus(); }, [receipt]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const updateClock = () => {
      clearTimeout(timer);
      const now = Date.now() / 1000 + clockOffset;
      setEpoch(now);
      const deadlines = products.map(p => p.early_bird_ends_at_epoch).filter((end): end is number => typeof end === 'number' && end > now);
      if (deadlines.length) timer = setTimeout(updateClock, Math.min(2147483647, Math.ceil((Math.min(...deadlines) - now) * 1000)));
    };
    updateClock();
    window.addEventListener('focus', updateClock);
    document.addEventListener('visibilitychange', updateClock);
    return () => { clearTimeout(timer); window.removeEventListener('focus', updateClock); document.removeEventListener('visibilitychange', updateClock); };
  }, [products, clockOffset]);

  const find = (id: string) => products.find(p => p.id === id)!;
  const lineTotal = (line: Line) => line.kind === 'single' ? priceAt(find(line.product_id), epoch) * line.quantity : line.size === 3 ? settings.bundle_three_cents : settings.bundle_five_cents;
  const total = lines.reduce((sum, line) => sum + lineTotal(line), 0);
  const count = lines.reduce((sum, line) => sum + (line.kind === 'single' ? line.quantity : line.size), 0);
  const selected = (id: string) => lines.reduce((sum, line) => sum + (line.kind === 'single' ? line.product_id === id ? line.quantity : 0 : line.items.filter(i => i.product_id === id).reduce((s, i) => s + i.quantity, 0)), 0);
  const canAdd = (p: Product, quantity = 1) => p.active && selected(p.id) + quantity <= 99 && (p.preorder || selected(p.id) + quantity <= (p.stock ?? 0));

  function addSingle(product: Product) {
    if (locked || !canAdd(product)) return;
    const size = product.sizes.length ? sizes[product.id] || product.sizes[0] : '';
    setLines(previous => {
      const index = previous.findIndex(l => l.kind === 'single' && l.product_id === product.id && l.size === size);
      if (index < 0) return [...previous, { kind: 'single', product_id: product.id, quantity: 1, size }];
      return previous.map((l, i) => i === index && l.kind === 'single' ? { ...l, quantity: l.quantity + 1 } : l);
    });
    setReceipt(null); setNotice(`${product.name}${size ? ` (${size})` : ''} added to your order.`);
  }

  function addPack() {
    const quantities: Record<string, number> = {};
    packChoices.slice(0, packSize).forEach(id => { quantities[id] = (quantities[id] || 0) + 1; });
    if (Object.entries(quantities).some(([id, q]) => !canAdd(find(id), q))) {
      setNotice('Not enough stock for that pack. Choose another combination.'); return;
    }
    setLines(previous => [...previous, { kind: 'bundle', size: packSize, items: Object.entries(quantities).map(([product_id, quantity]) => ({ product_id, quantity })) }]);
    setReceipt(null); setNotice(`${packSize}-sticker pack added to your order.`);
  }

  async function checkout(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || (!pending && !ready)) return;
    if (!pending && !validEmail(email)) {
      setEmailError('Enter a valid email address, such as you@example.com.');
      document.getElementById('email')?.focus();
      return;
    }
    setEmailError('');
    const attempt = pending || { key: crypto.randomUUID(), email: email.trim(), lines, expected_total_cents: total };
    try { sessionStorage.setItem(storageKey, JSON.stringify(attempt)); }
    catch { setError('Enable browser session storage so we can safely retry your order.'); return; }
    setPending(attempt); setBusy(true); setError('');
    try {
      const response = await fetch(`${url}/functions/v1/checkout`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', apikey: apiKey },
        body: JSON.stringify(attempt), signal: AbortSignal.timeout(30000),
      });
      const result = await response.json();
      if (!response.ok) {
        // Definitive validation rejection means no order was committed.
        if ([400, 409, 413, 415].includes(response.status)) {
          sessionStorage.removeItem(storageKey); setPending(null);
        }
        setError(result.error || 'Please retry this same order to confirm its status.');
        if (Number.isFinite(result.server_epoch)) { setClockOffset(result.server_epoch - Date.now() / 1000); setEpoch(result.server_epoch); }
        if (result.code === 'OUT_OF_STOCK' || result.code === 'PRICE_CHANGED') await refresh();
        return;
      }
      sessionStorage.removeItem(storageKey); setPending(null);
      setReceipt(result.order); setLines([]); setEmail('');
      await refresh();
    } catch { setError('We could not confirm the result. Retry the same order below; it will not be placed twice.'); }
    finally { setBusy(false); }
  }

  return <div className="shop-layout" id="shop">
    <section aria-labelledby="collection-title" className="min-w-0">
      <div className="section-heading"><div><p className="eyebrow">THE AIMS COLLECTION</p><h2 id="collection-title">Small things. Big spirit.</h2></div><span className="collection-count">09 / pieces</span></div>
      <div className="filters" aria-label="Product categories">{[['all', 'Everything'], ['stickers', 'Stickers'], ['wear', 'Wear it'], ['keychains', 'Take it along']].map(([value, label]) => <button type="button" key={value} aria-pressed={category === value} onClick={() => setCategory(value)}>{label}</button>)}</div>
      <div className="product-grid">{products.filter(p => category === 'all' || p.category === category).map((p, index) => <article key={p.id} className="product-card">
        <div className={`product-image ${p.category}`}><ProductImage name={p.image} alt={`${p.name}: ${p.detail}`} eager={index < 3} />{p.preorder && <div className="image-badges"><span className="image-tag">PREORDER</span><span className="image-tag">MADE TO ORDER</span></div>}{!p.preorder && isEarlyBird(p, epoch) && <span className="image-tag">EARLY BIRD - UNTIL 29 OCT</span>}{!p.active || p.stock === 0 ? <span className="image-tag sold">SOLD OUT</span> : null}</div>
        <div className="product-info"><div className="product-title"><h3>{p.name}</h3><span>{isEarlyBird(p, epoch) && <del className="regular-price">{money(p.price_cents)}</del>}{money(priceAt(p, epoch))}</span></div><p className="product-detail">{p.detail}</p>
          {!p.preorder && loaded && <p className="stock-note">{p.stock} available</p>}
          <div className="product-actions">{p.sizes.length > 0 && <select aria-label={`${p.name} size`} value={sizes[p.id] || p.sizes[0]} disabled={locked} onChange={e => setSizes({ ...sizes, [p.id]: e.target.value })}>{p.sizes.map(size => <option key={size}>{size}</option>)}</select>}<button className="add-button" type="button" disabled={locked || !canAdd(p) || lines.length >= 50} onClick={() => addSingle(p)}>{!p.active || p.stock === 0 ? 'Sold out' : 'Add to order'}<Plus size={16} aria-hidden="true" /></button></div>
        </div>
      </article>)}</div>
      {(category === 'all' || category === 'stickers') && <section className="bundle-builder" aria-labelledby="bundle-title"><div className="bundle-intro"><span className="eyebrow">BETTER TOGETHER</span><h3 id="bundle-title">Make a little sticker pack.</h3><p>Mix your favorites. Repeat a design. Make it yours.</p></div><div className="pack-options">{([3, 5] as const).map(size => <button type="button" key={size} aria-pressed={packSize === size} disabled={locked} onClick={() => setPackSize(size)}>{size} stickers <strong>{money(size === 3 ? settings.bundle_three_cents : settings.bundle_five_cents)}</strong></button>)}</div><div className="pack-choices">{packChoices.slice(0, packSize).map((id, i) => <StickerSelect key={i} label={`Sticker ${i + 1} in pack`} selected={find(id)} options={products.filter(p => p.category === 'stickers' && p.active)} disabled={locked} onChange={id => setPackChoices(previous => previous.map((value, index) => index === i ? id : value))} />)}</div><button type="button" className="primary-button" disabled={locked || lines.length >= 50} onClick={addPack}>Add {packSize}-sticker pack <span className="button-end">{money(packSize === 3 ? settings.bundle_three_cents : settings.bundle_five_cents)}<ArrowUpRight size={16} aria-hidden="true" /></span></button><p className="bundle-note">Pack prices apply only to packs you add here.</p></section>}
      <p className="sr-only" role="status">{notice}</p>
    </section>

    <aside className="order-panel" id="your-order" aria-labelledby="order-title"><div className="order-heading"><h2 id="order-title">Your order</h2><span className="count-badge">{count}</span></div>
      {receipt && <div className="confirmation" id="order-confirmation" tabIndex={-1} role="status"><span className="eyebrow">{receipt.status === 'cancelled' ? 'ORDER CANCELLED' : 'YOU’RE ALL SET'}</span><h3>{receipt.status === 'cancelled' ? 'This order was cancelled.' : 'A little AIMS, reserved.'}</h3><p>Reference: <strong>{receipt.id}</strong></p>{receipt.lines.map((l, i) => <p key={i}>{l.quantity} × {l.name} {l.size} — {money(l.total_cents)}</p>)}<p><strong>{money(receipt.total_cents)} · pay at pickup</strong></p><p>{receipt.pickup_address}</p>{receipt.lines.some(l => l.preorder) && <p>Your sweatshirt is a preorder. Its pickup date will be confirmed separately.</p>}<p>Confirmation email queued. Keep this reference for pickup.</p></div>}
      {lines.length === 0 ? <div className="empty-order"><span className="empty-order-icon"><ShoppingBag size={20} aria-hidden="true" /></span><p>A little something for you?</p><small>Add your favorites to get started.</small></div> : <ul className="order-lines">{lines.map((line, i) => <li key={i}><div><strong>{line.kind === 'single' ? find(line.product_id).name : `${line.size}-sticker pack`}</strong><p>{line.kind === 'single' ? `${line.size ? `${line.size} · ` : ''}Qty ${line.quantity}` : line.items.map(item => `${item.quantity} × ${find(item.product_id).name}`).join(', ')}</p><button type="button" disabled={locked} onClick={() => setLines(previous => previous.filter((_, index) => index !== i))} aria-label={`Remove ${line.kind === 'single' ? find(line.product_id).name : 'sticker pack'}`}>Remove</button></div><span>{money(lineTotal(line))}</span></li>)}</ul>}
      <div className="order-total"><span>Total at pickup</span><strong>{money(total)}</strong></div>
      <form onSubmit={checkout} noValidate><label className="email-label" htmlFor="email">Your email</label><input id="email" type="email" name="email" placeholder="you@uw.edu" autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false} maxLength={254} pattern={emailPattern.source} required value={email} disabled={locked} aria-invalid={Boolean(emailError)} aria-describedby={emailError ? 'email-help email-error' : 'email-help'} onChange={e => { setEmail(e.target.value); if (emailError && validEmail(e.target.value)) setEmailError(''); }} onBlur={() => setEmailError(email && !validEmail(email) ? 'Enter a valid email address, such as you@example.com.' : '')} /><p id="email-help" className="field-help">For your confirmation and pickup updates.</p>
        {emailError && <p id="email-error" className="form-error" role="alert">{emailError}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button type="submit" className="primary-button checkout-button" disabled={busy || lines.length === 0 || (!pending && !ready)}>{busy ? 'Confirming your order…' : pending ? 'Retry this order safely' : 'Place pickup order'}<ArrowUpRight size={16} aria-hidden="true" /></button>
        {!ready && !pending && <p className="availability-note">{configured ? loaded ? 'Orders will open soon.' : 'Checking current availability…' : 'The collection is open for browsing. Ordering opens soon.'}</p>}
        {configured && !loaded && <button className="text-button" type="button" disabled={busy} onClick={() => { setError(''); void refresh(); }}>Refresh availability</button>}
        <p className="payment-note">No payment now. Pay when you pick up.</p>
      </form>
      <div className="pickup-note"><MapPin size={20} aria-hidden="true" /><div><strong>Made for local pickup</strong><p>{settings.pickup_address || 'Pickup location will be announced before orders open.'}</p><p>Sweatshirts are made to order. We’ll confirm their pickup timing separately.</p></div></div>
    </aside>
    <a className="mobile-order-link" href="#your-order">Your order · {count} items <strong>{money(total)} <ArrowDown size={16} aria-hidden="true" /></strong></a>
  </div>;
}
