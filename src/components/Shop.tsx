import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUpRight, MapPin, Minus, Plus, ShoppingBag } from 'lucide-react';
import { catalog, money, type Product } from '../data/catalog';
import imageData from '../data/assets.json';
import StickerSelect from './StickerSelect';
import { isEarlyBird, priceAt } from '../lib/pricing';

type Single = { kind: 'single'; product_id: string; quantity: number; size: string };
type Pack = { kind: 'bundle'; size: 3 | 5; items: { product_id: string; quantity: number }[] };
type Line = Single | Pack;
type Settings = { pickup_address: string; orders_open: boolean; bundle_three_cents: number; bundle_five_cents: number };
type Customer = { full_name: string; phone_number: string; zelle_payer_name: string; payment_reference: string; pickup_option: string };
type PaymentProof = { file_name: string; content_type: string; data: string };
type Attempt = { key: string; email: string; lines: Line[]; expected_total_cents: number; customer: Customer; payment_proof: PaymentProof; paid_total_confirmed_cents: number };
type Receipt = { id: string; total_cents: number; pickup_address: string; status: string; lines: { name: string; size?: string; quantity: number; total_cents: number; preorder: boolean }[] };
type Asset = { src: string; width: number; height: number; variants: { src: string; width: number }[] };
const assets = imageData as Record<string, Asset>;
const storageKey = 'aims-pending-checkout';
const maxProofBytes = 1_048_576;
const proofTypes = ['image/jpeg', 'image/png', 'image/webp'];
const pickupOptions = [
  { value: 'mgh_440', label: 'MGH 440', detail: 'Pickup time will be decided via further communication.' },
  { value: 'ianniversary_2026_10_29', label: 'iAnniversary · October 29, 3–6 PM', detail: 'October 29, 3–6 PM.' },
];
const emailPattern = /^[^\s@]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;
const validEmail = (value: string) => value.trim().length <= 254 && emailPattern.test(value.trim());
const defaults: Settings = { pickup_address: '', orders_open: false, bundle_three_cents: 399, bundle_five_cents: 749 };
const blankCustomer: Customer = { full_name: '', phone_number: '', zelle_payer_name: '', payment_reference: '', pickup_option: '' };
const packHint = 'Three or more individual stickers cost more than a pack. Choose a 3 or 5 sticker pack instead.';

function proofBytes(proof: PaymentProof): ArrayBuffer {
  const decoded = atob(proof.data);
  const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0));
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function readProof(file: File): Promise<PaymentProof> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The payment screenshot could not be read.'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string' || !result.includes(',')) {
        reject(new Error('The payment screenshot could not be read.'));
        return;
      }
      resolve({ file_name: file.name, content_type: file.type, data: result.slice(result.indexOf(',') + 1) });
    };
    reader.readAsDataURL(file);
  });
}

function ProductImage({ name, alt, eager = false }: { name: string; alt: string; eager?: boolean }) {
  const asset = assets[name];
  return <img src={asset.src} srcSet={asset.variants.map(v => `${v.src} ${v.width}w`).join(', ')} sizes="(max-width: 640px) 44vw, (max-width: 1100px) 30vw, 280px" width={asset.width} height={asset.height} alt={alt} loading={eager ? 'eager' : 'lazy'} decoding="async" />;
}

function QuantityStepper({ value, label, minusDisabled, plusDisabled, onMinus, onPlus }: { value: number; label: string; minusDisabled: boolean; plusDisabled: boolean; onMinus: () => void; onPlus: () => void }) {
  return <div className="qty-stepper" role="group" aria-label={`${label} quantity`}>
    <button type="button" aria-label={`Decrease ${label}`} disabled={minusDisabled} onClick={onMinus}><Minus size={14} aria-hidden="true" /></button>
    <span aria-live="polite">{value}</span>
    <button type="button" aria-label={`Increase ${label}`} disabled={plusDisabled} onClick={onPlus}><Plus size={14} aria-hidden="true" /></button>
  </div>;
}

export default function Shop({ url, apiKey, initialEpoch }: { url: string; apiKey: string; initialEpoch: number }) {
  const [epoch, setEpoch] = useState(initialEpoch);
  const [clockOffset, setClockOffset] = useState(0);
  const [products, setProducts] = useState<Product[]>(catalog);
  const [detailsProductId, setDetailsProductId] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(defaults);
  const [category, setCategory] = useState('all');
  const [lines, setLines] = useState<Line[]>([]);
  const [sizes, setSizes] = useState<Record<string, string>>({ crewneck: 'M' });
  const [email, setEmail] = useState('');
  const [emailConfirmation, setEmailConfirmation] = useState('');
  const [emailError, setEmailError] = useState('');
  const [emailConfirmationError, setEmailConfirmationError] = useState('');
  const [customer, setCustomer] = useState<Customer>(blankCustomer);
  const [phoneConfirmation, setPhoneConfirmation] = useState('');
  const [phoneConfirmationError, setPhoneConfirmationError] = useState('');
  const [paidTotalConfirmedCents, setPaidTotalConfirmedCents] = useState<number | null>(null);
  const [paymentProof, setPaymentProof] = useState<PaymentProof | null>(null);
  const [proofError, setProofError] = useState('');
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
  const ready = configured && loaded && settings.orders_open;

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
          if (attempt.customer && typeof attempt.customer === 'object') setCustomer(attempt.customer);
          if (attempt.payment_proof && typeof attempt.payment_proof.data === 'string') setPaymentProof(attempt.payment_proof);
          if (Number.isSafeInteger(attempt.paid_total_confirmed_cents)) setPaidTotalConfirmedCents(attempt.paid_total_confirmed_cents);
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
  const selected = (id: string, from = lines) => from.reduce((sum, line) => sum + (line.kind === 'single' ? line.product_id === id ? line.quantity : 0 : line.items.filter(i => i.product_id === id).reduce((s, i) => s + i.quantity, 0)), 0);
  const canAdd = (p: Product, quantity = 1, from = lines) => p.active && selected(p.id, from) + quantity <= 99 && (p.preorder || selected(p.id, from) + quantity <= (p.stock ?? 0));
  const singleQty = (productId: string, size: string, from = lines) => from.reduce((sum, line) => sum + (line.kind === 'single' && line.product_id === productId && line.size === size ? line.quantity : 0), 0);
  const stickerSingles = (from = lines) => from.reduce((sum, line) => sum + (line.kind === 'single' && find(line.product_id)?.category === 'stickers' ? line.quantity : 0), 0);
  const showPackPrompt = stickerSingles() >= 3;

  function commit(next: Line[], message: string) {
    setLines(next);
    setReceipt(null);
    setPaidTotalConfirmedCents(null);
    setNotice(message);
  }

  function changeSingle(product: Product, size: string, delta: number) {
    if (locked || !delta) return;
    if (delta > 0 && !canAdd(product, delta)) return;
    const index = lines.findIndex(l => l.kind === 'single' && l.product_id === product.id && l.size === size);
    if (index < 0) {
      if (delta <= 0 || lines.length >= 50) return;
      commit([...lines, { kind: 'single', product_id: product.id, quantity: delta, size }], `${product.name}${size ? ` (${size})` : ''} added to your order.`);
      return;
    }
    const current = lines[index] as Single;
    const quantity = current.quantity + delta;
    commit(quantity <= 0 ? lines.filter((_, i) => i !== index) : lines.map((l, i) => i === index && l.kind === 'single' ? { ...l, quantity } : l), `${product.name} updated.`);
  }

  function addPackFrom(items: Pack['items'], size: 3 | 5) {
    const quantities: Record<string, number> = {};
    items.forEach(item => { quantities[item.product_id] = (quantities[item.product_id] || 0) + item.quantity; });
    if (Object.entries(quantities).some(([id, q]) => !canAdd(find(id), q))) {
      setNotice('Not enough stock for that pack. Choose another combination.'); return;
    }
    if (lines.length >= 50) return;
    commit([...lines, { kind: 'bundle', size, items: Object.entries(quantities).map(([product_id, quantity]) => ({ product_id, quantity })) }], `${size}-sticker pack added to your order.`);
  }

  function addPack() {
    const quantities: Record<string, number> = {};
    packChoices.slice(0, packSize).forEach(id => { quantities[id] = (quantities[id] || 0) + 1; });
    addPackFrom(Object.entries(quantities).map(([product_id, quantity]) => ({ product_id, quantity })), packSize);
  }

  function changePack(index: number, delta: number) {
    const line = lines[index];
    if (locked || !line || line.kind !== 'bundle' || !delta) return;
    if (delta < 0) {
      commit(lines.filter((_, i) => i !== index), 'Sticker pack removed.');
      return;
    }
    addPackFrom(line.items, line.size);
  }

  function openPackBuilder() {
    setCategory('stickers');
    window.setTimeout(() => document.getElementById('bundle-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }

  async function checkout(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || (!pending && !ready)) return;
    if (paidTotalConfirmedCents !== total) {
      setError('Confirm that you have paid the total shown above before placing the order.');
      document.getElementById('paid-total-confirmation')?.focus();
      return;
    }
    if (!pending && !validEmail(email)) {
      setEmailError('Enter a valid email address, such as you@example.com.');
      document.getElementById('email')?.focus();
      return;
    }
    setEmailError('');
    if (!pending) {
      if (!validEmail(emailConfirmation) || email.trim().toLowerCase() !== emailConfirmation.trim().toLowerCase()) {
        setEmailConfirmationError('Enter the same valid email address in both fields.');
        setError('The email addresses must match.');
        document.getElementById('email-confirmation')?.focus();
        return;
      }
      setEmailConfirmationError('');
      const phoneDigits = customer.phone_number.replace(/\D/g, '');
      const invalidField = !customer.full_name.trim() || customer.full_name.trim().length > 120 ? 'full-name'
        : phoneDigits.length < 7 || phoneDigits.length > 15 || !/^[+0-9 ().-]+$/.test(customer.phone_number.trim()) ? 'phone-number'
        : phoneConfirmation.replace(/\D/g, '') !== phoneDigits ? 'phone-confirmation'
        : !customer.zelle_payer_name.trim() || customer.zelle_payer_name.trim().length > 120 ? 'zelle-payer-name'
        : !customer.pickup_option ? 'pickup-option'
        : !paymentProof ? 'payment-proof'
        : '';
      if (invalidField) {
        const messages: Record<string, string> = {
          'full-name': 'Enter your full name (up to 120 characters).',
          'phone-number': 'Enter a valid phone number with 7 to 15 digits.',
          'phone-confirmation': 'Enter the same phone number in both fields.',
          'zelle-payer-name': 'Enter the name shown on your Zelle payment.',
          'pickup-option': 'Choose a pickup location.',
          'payment-proof': 'Upload a screenshot of your completed payment.',
        };
        if (invalidField === 'phone-confirmation') setPhoneConfirmationError(messages[invalidField]);
        if (invalidField === 'payment-proof') setProofError(messages[invalidField]);
        setError(messages[invalidField]);
        document.getElementById(invalidField)?.focus();
        return;
      }
    }
    const attempt: Attempt = pending ? { ...pending, paid_total_confirmed_cents: total } : {
      key: crypto.randomUUID(),
      email: email.trim(),
      lines,
      expected_total_cents: total,
      customer: {
        full_name: customer.full_name.trim(),
        phone_number: customer.phone_number.trim(),
        zelle_payer_name: customer.zelle_payer_name.trim(),
        payment_reference: customer.payment_reference.trim(),
        pickup_option: customer.pickup_option,
      },
      payment_proof: paymentProof!,
      paid_total_confirmed_cents: total,
    };
    try { sessionStorage.setItem(storageKey, JSON.stringify(attempt)); }
    catch { setError('Enable browser session storage so we can safely retry your order.'); return; }
    setPending(attempt); setBusy(true); setError('');
    try {
      const proofResponse = await fetch(`${url}/functions/v1/checkout`, {
        method: 'POST',
        headers: {
          apikey: apiKey,
          'Content-Type': attempt.payment_proof.content_type,
          'x-payment-proof-key': attempt.key,
          'x-payment-proof-email': attempt.email.trim().toLowerCase(),
        },
        body: proofBytes(attempt.payment_proof),
        signal: AbortSignal.timeout(30000),
      });
      let proofResult: { error?: string; payment_proof_path?: string };
      try { proofResult = await proofResponse.json(); }
      catch {
        proofResult = { error: proofResponse.status === 413
          ? 'The screenshot upload exceeded the server limit. Choose a smaller image and try again.'
          : 'The payment screenshot could not be uploaded. Retry this order safely.' };
      }
      if (!proofResponse.ok) {
        if ([400, 409, 413, 415].includes(proofResponse.status)) {
          sessionStorage.removeItem(storageKey); setPending(null);
        }
        setError(proofResult.error || 'The payment screenshot could not be uploaded. Retry this order safely.');
        return;
      }
      const response = await fetch(`${url}/functions/v1/checkout`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', apikey: apiKey },
        body: JSON.stringify({
          key: attempt.key,
          email: attempt.email,
          lines: attempt.lines,
          expected_total_cents: attempt.expected_total_cents,
          paid_total_confirmed_cents: attempt.paid_total_confirmed_cents,
          customer: attempt.customer,
          payment_proof_path: proofResult.payment_proof_path,
        }),
        signal: AbortSignal.timeout(30000),
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
      setReceipt(result.order); setLines([]); setEmail(''); setEmailConfirmation(''); setCustomer(blankCustomer); setPhoneConfirmation(''); setPaymentProof(null); setPaidTotalConfirmedCents(null);
      await refresh();
    } catch { setError('We could not confirm the result. Retry the same order below; it will not be placed twice.'); }
    finally { setBusy(false); }
  }

  return <div className="shop-layout" id="shop">
    <section aria-labelledby="collection-title" className="min-w-0">
      <div className="section-heading"><div><p className="eyebrow">THE AIMS COLLECTION</p><h2 id="collection-title">Small things. Big spirit.</h2></div><span className="collection-count">09 / pieces</span></div>
      <div className="filters" aria-label="Product categories">{[['all', 'Everything'], ['stickers', 'Stickers'], ['wear', 'Wear it'], ['keychains', 'Take it along']].map(([value, label]) => <button type="button" key={value} aria-pressed={category === value} onClick={() => setCategory(value)}>{label}</button>)}</div>
      <div className="product-grid">{products.filter(p => category === 'all' || p.category === category).map((p, index) => {
        const size = p.sizes.length ? sizes[p.id] || p.sizes[0] : '';
        const quantity = singleQty(p.id, size);
        const label = `${p.name}${size ? ` ${size}` : ''}`;
        return <article key={p.id} className="product-card">
        <div className={`product-image ${p.category}`}><ProductImage name={p.image} alt={`${p.name}: ${p.detail}`} eager={index < 3} />{p.preorder && <div className="image-badges"><span className="image-tag">PREORDER</span><span className="image-tag">MADE TO ORDER</span>{isEarlyBird(p, epoch) && <span className="image-tag">EARLY BIRD - UNTIL 29 OCT</span>}</div>}{!p.preorder && isEarlyBird(p, epoch) && <span className="image-tag">EARLY BIRD - UNTIL 29 OCT</span>}{!p.active || p.stock === 0 ? <span className="image-tag sold">SOLD OUT</span> : null}</div>
        <div className="product-info"><div className="product-title"><h3>{p.name}</h3><span>{isEarlyBird(p, epoch) && <del className="regular-price">{money(p.price_cents)}</del>}{money(priceAt(p, epoch))}</span></div><p className="product-detail">{p.detail}</p><p className="product-material-detail">{p.material_detail}</p>
          <button type="button" className="product-details-trigger" aria-haspopup="dialog" aria-expanded={detailsProductId === p.id} aria-controls={`details-${p.id}`} title={`More information about ${p.name}`} onClick={() => setDetailsProductId(detailsProductId === p.id ? null : p.id)}>More information <ArrowUpRight size={13} aria-hidden="true" /></button>
          {!p.preorder && loaded && <p className="stock-note">{p.stock} available</p>}
          <div className="product-actions">{p.sizes.length > 0 && <select aria-label={`${p.name} size`} value={sizes[p.id] || p.sizes[0]} disabled={locked} onChange={e => setSizes({ ...sizes, [p.id]: e.target.value })}>{p.sizes.map(option => <option key={option}>{option}</option>)}</select>}
            {quantity > 0 ? <QuantityStepper value={quantity} label={`${label} in collection`} minusDisabled={locked} plusDisabled={locked || !canAdd(p)} onMinus={() => changeSingle(p, size, -1)} onPlus={() => changeSingle(p, size, 1)} />
            : <button className="add-button" type="button" disabled={locked || !canAdd(p) || lines.length >= 50} onClick={() => changeSingle(p, size, 1)}>{!p.active || p.stock === 0 ? 'Sold out' : 'Add to order'}<Plus size={16} aria-hidden="true" /></button>}
          </div>
        </div>
        {detailsProductId === p.id && <div className="product-details-backdrop" onClick={() => setDetailsProductId(null)} onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); setDetailsProductId(null); }
        }}>
          <section id={`details-${p.id}`} className="product-details-dialog" role="dialog" aria-labelledby={`details-title-${p.id}`} onClick={event => event.stopPropagation()}>
            <div className="product-details-heading"><div><span className="eyebrow">PRODUCT DETAILS</span><h4 id={`details-title-${p.id}`}>{p.name}</h4></div><button type="button" className="product-details-close" aria-label={`Close ${p.name} details`} onClick={() => setDetailsProductId(null)}>×</button></div>
            <ul>{p.specifications.map(specification => <li key={specification}>{specification}</li>)}</ul>
          </section>
        </div>}
      </article>;
      })}</div>
      {(category === 'all' || category === 'stickers') && <section className="bundle-builder" aria-labelledby="bundle-title"><div className="bundle-intro"><span className="eyebrow">BETTER TOGETHER</span><h3 id="bundle-title">Make a little sticker pack.</h3><p>Mix your favorites. Repeat a design. Make it yours.</p></div><div className="pack-options">{([3, 5] as const).map(size => <button type="button" key={size} aria-pressed={packSize === size} disabled={locked} onClick={() => setPackSize(size)}>{size} stickers <strong>{money(size === 3 ? settings.bundle_three_cents : settings.bundle_five_cents)}</strong></button>)}</div><div className="pack-choices">{packChoices.slice(0, packSize).map((id, i) => <StickerSelect key={i} label={`Sticker ${i + 1} in pack`} selected={find(id)} options={products.filter(p => p.category === 'stickers' && p.active)} disabled={locked} onChange={id => setPackChoices(previous => previous.map((value, index) => index === i ? id : value))} />)}</div><button type="button" className="primary-button" disabled={locked || lines.length >= 50} onClick={addPack}>Add {packSize}-sticker pack <span className="button-end">{money(packSize === 3 ? settings.bundle_three_cents : settings.bundle_five_cents)}<ArrowUpRight size={16} aria-hidden="true" /></span></button><p className="bundle-note">Pack prices apply only to packs you add here.</p></section>}
      <p className="sr-only" role="status">{notice}</p>
    </section>

    <aside className="order-panel" id="your-order" aria-labelledby="order-title"><div className="order-heading"><h2 id="order-title">Your order</h2><span className="count-badge">{count}</span></div>
      {showPackPrompt && <div className="pack-prompt" role="status"><p>{packHint}</p><button type="button" onClick={openPackBuilder}>Choose a pack</button></div>}
      {receipt && <div className="confirmation" id="order-confirmation" tabIndex={-1} role="status"><span className="eyebrow">{receipt.status === 'cancelled' ? 'ORDER CANCELLED' : 'YOU’RE ALL SET'}</span><h3>{receipt.status === 'cancelled' ? 'This order was cancelled.' : 'A little AIMS, reserved.'}</h3><p>Reference: <strong>{receipt.id}</strong></p>{receipt.lines.map((l, i) => <p key={i}>{l.quantity} × {l.name} {l.size} — {money(l.total_cents)}</p>)}<p><strong>{money(receipt.total_cents)} · payment proof submitted</strong></p><p>{receipt.pickup_address}</p>{receipt.lines.some(l => l.preorder) && <p>Sweatshirt pick-up information will be sent over email in the coming weeks.</p>}<p>Please reach out to <a href="mailto:ainforms@uw.edu">ainforms@uw.edu</a> if you did not receive the confirmation email or have any questions. Keep this reference for pickup.</p></div>}
      {lines.length === 0 ? <div className="empty-order"><span className="empty-order-icon"><ShoppingBag size={20} aria-hidden="true" /></span><p>A little something for you?</p><small>Add your favorites to get started.</small></div> : <ul className="order-lines">{lines.map((line, i) => {
        const name = line.kind === 'single' ? find(line.product_id).name : `${line.size}-sticker pack`;
        const product = line.kind === 'single' ? find(line.product_id) : null;
        const canIncrease = line.kind === 'single' ? Boolean(product && canAdd(product)) : line.items.every(item => canAdd(find(item.product_id), item.quantity)) && lines.length < 50;
        return <li key={i}><div><strong>{name}</strong><p>{line.kind === 'single' ? `${line.size ? `${line.size} · ` : ''}Qty ${line.quantity}` : line.items.map(item => `${item.quantity} × ${find(item.product_id).name}`).join(', ')}</p>
          <QuantityStepper value={line.kind === 'single' ? line.quantity : 1} label={`${name} in your order`} minusDisabled={locked} plusDisabled={locked || !canIncrease} onMinus={() => line.kind === 'single' && product ? changeSingle(product, line.size, -1) : changePack(i, -1)} onPlus={() => line.kind === 'single' && product ? changeSingle(product, line.size, 1) : changePack(i, 1)} />
          <button type="button" disabled={locked} onClick={() => commit(lines.filter((_, index) => index !== i), `${name} removed.`)} aria-label={`Remove ${name}`}>Remove</button></div><span>{money(lineTotal(line))}</span></li>;
      })}</ul>}
      <div className="order-total"><span>Order total</span><strong>{money(total)}</strong></div>
      <section className="zelle-payment" aria-labelledby="zelle-payment-title">
        <h3 id="zelle-payment-title">Pay with Zelle</h3>
        <p>Send your Zelle payment to <strong>ainforms@uw.edu</strong>. Scan this code in your banking app.</p>
        <img src="/images/payment/zelle-payment.png" width="450" height="590" alt="Zelle payment QR code for AIMS at ainforms@uw.edu" loading="lazy" decoding="async" />
      </section>
      <form onSubmit={checkout} noValidate>
        <label className="email-label" htmlFor="email">Your email</label><input id="email" type="email" name="email" placeholder="you@uw.edu" autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false} maxLength={254} pattern={emailPattern.source} required value={email} disabled={locked} aria-invalid={Boolean(emailError)} aria-describedby={emailError ? 'email-help email-error' : 'email-help'} onChange={e => { setEmail(e.target.value); setEmailError(''); setEmailConfirmationError(''); }} onBlur={() => setEmailError(email && !validEmail(email) ? 'Enter a valid email address, such as you@example.com.' : '')} /><p id="email-help" className="field-help">For your confirmation and pickup updates.</p>
        <label className="checkout-field" htmlFor="email-confirmation">Confirm email<input id="email-confirmation" type="email" name="email_confirmation" placeholder="Re-enter your email" autoComplete="off" inputMode="email" autoCapitalize="none" spellCheck={false} maxLength={254} pattern={emailPattern.source} required value={emailConfirmation} disabled={locked} aria-invalid={Boolean(emailConfirmationError)} aria-describedby={emailConfirmationError ? 'email-confirmation-error' : undefined} onChange={e => { setEmailConfirmation(e.target.value); setEmailConfirmationError(''); }} onBlur={() => setEmailConfirmationError(emailConfirmation && email.trim().toLowerCase() !== emailConfirmation.trim().toLowerCase() ? 'Email addresses do not match.' : '')} />{emailConfirmationError && <span id="email-confirmation-error" className="field-help form-error" role="alert">{emailConfirmationError}</span>}</label>
        <label className="checkout-field" htmlFor="full-name">Full name<input id="full-name" name="full_name" autoComplete="name" maxLength={120} required value={customer.full_name} disabled={locked} onChange={e => setCustomer({ ...customer, full_name: e.target.value })} /></label>
        <label className="checkout-field" htmlFor="phone-number">Phone number<input id="phone-number" name="phone_number" type="tel" autoComplete="tel" inputMode="tel" maxLength={30} required value={customer.phone_number} disabled={locked} onChange={e => { setCustomer({ ...customer, phone_number: e.target.value }); setPhoneConfirmationError(''); }} /></label>
        <label className="checkout-field" htmlFor="phone-confirmation">Confirm phone number<input id="phone-confirmation" name="phone_confirmation" type="tel" autoComplete="off" inputMode="tel" maxLength={30} required value={phoneConfirmation} disabled={locked} aria-invalid={Boolean(phoneConfirmationError)} aria-describedby={phoneConfirmationError ? 'phone-confirmation-error' : undefined} onChange={e => { setPhoneConfirmation(e.target.value); setPhoneConfirmationError(''); }} onBlur={() => setPhoneConfirmationError(phoneConfirmation && customer.phone_number.replace(/\D/g, '') !== phoneConfirmation.replace(/\D/g, '') ? 'Phone numbers do not match.' : '')} />{phoneConfirmationError && <span id="phone-confirmation-error" className="field-help form-error" role="alert">{phoneConfirmationError}</span>}</label>
        <label className="checkout-field" htmlFor="zelle-payer-name">Zelle payer name<input id="zelle-payer-name" name="zelle_payer_name" autoComplete="name" maxLength={120} required value={customer.zelle_payer_name} disabled={locked} onChange={e => setCustomer({ ...customer, zelle_payer_name: e.target.value })} /></label>
        <label className="checkout-field" htmlFor="payment-reference">Payment reference / memo <span>(optional)</span><input id="payment-reference" name="payment_reference" maxLength={500} value={customer.payment_reference} disabled={locked} onChange={e => setCustomer({ ...customer, payment_reference: e.target.value })} /></label>
        <fieldset id="pickup-option" className="pickup-options" disabled={locked}><legend>Pickup location</legend>{pickupOptions.map(option => <label key={option.value}><input id={`pickup-${option.value}`} type="radio" name="pickup_option" value={option.value} required checked={customer.pickup_option === option.value} onChange={e => setCustomer({ ...customer, pickup_option: e.target.value })} /><span><strong>{option.label}</strong><small>{option.detail}</small></span></label>)}</fieldset>
        <label className="checkout-field proof-field" htmlFor="payment-proof">Payment screenshot<input id="payment-proof" name="payment_proof" type="file" accept="image/jpeg,image/png,image/webp" required disabled={locked} aria-describedby="proof-help" onChange={async e => {
          const file = e.currentTarget.files?.[0];
          setProofError('');
          if (!file) { setPaymentProof(null); return; }
          if (!proofTypes.includes(file.type) || file.size === 0 || file.size > maxProofBytes) {
            setPaymentProof(null);
            setProofError('Choose a PNG, JPG, or WEBP screenshot smaller than 1 MB.');
            e.currentTarget.value = '';
            return;
          }
          try { setPaymentProof(await readProof(file)); }
          catch (readError) { setPaymentProof(null); setProofError(readError instanceof Error ? readError.message : 'The payment screenshot could not be read.'); }
        }} /><span id="proof-help" className="field-help">Upload a PNG, JPG, or WEBP image up to 1 MB. The image is stored privately with your order.</span>{paymentProof && <small className="proof-selected">Selected: {paymentProof.file_name}</small>}</label>
        {proofError && <p className="form-error" role="alert">{proofError}</p>}
        <p className="field-help">Sweatshirt pick-up information will be sent over email in the coming weeks.</p>
        <label className="payment-confirmation" htmlFor="paid-total-confirmation">
          <input id="paid-total-confirmation" type="checkbox" checked={paidTotalConfirmedCents === total} disabled={busy} onChange={event => setPaidTotalConfirmedCents(event.currentTarget.checked ? total : null)} />
          <span>I confirm that I have paid the order total of <strong>{money(total)}</strong> shown above.</span>
        </label>
        {emailError && <p id="email-error" className="form-error" role="alert">{emailError}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button type="submit" className="primary-button checkout-button" disabled={busy || lines.length === 0 || paidTotalConfirmedCents !== total || (!pending && !ready)}>{busy ? 'Confirming your order…' : pending ? 'Retry this order safely' : 'Place pickup order'}<ArrowUpRight size={16} aria-hidden="true" /></button>
        {!ready && !pending && <p className="availability-note">{configured ? loaded ? 'Orders will open soon.' : 'Checking current availability…' : 'The collection is open for browsing. Ordering opens soon.'}</p>}
        {configured && !loaded && <button className="text-button" type="button" disabled={busy} onClick={() => { setError(''); void refresh(); }}>Refresh availability</button>}
        <p className="payment-note">Upload your Zelle payment confirmation to place your order.</p>
      </form>
      <div className="pickup-note"><MapPin size={20} aria-hidden="true" /><div><strong>Made for local pickup</strong><p>Choose MGH 440 or iAnniversary on October 29, 3–6 PM above.</p></div></div>
    </aside>
    <a className="mobile-order-link" href="#your-order">Your order · {count} items <strong>{money(total)} <ArrowDown size={16} aria-hidden="true" /></strong></a>
  </div>;
}
