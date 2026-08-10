'use strict';

/**
 * HTML documentation for the Customer API.
 *
 * Served at /api/v2/docs for people; the machine-readable version stays at
 * /api/v2/docs.json.
 *
 * Design notes — the audience is resellers who live in a terminal and think in
 * transactions, so the page borrows that vocabulary: IBM Plex (a type family
 * with a heritage in financial systems and terminals), a deep petrol ground
 * rather than the usual near-black, and a signal palette taken straight from
 * the content itself — HTTP classes. The one thing the page is built around is
 * the status ledger: for a reseller a 402 is not a failure, it is "go top up",
 * so each code gets a plain-language instruction instead of a spec definition.
 */

function docsPage(baseUrl, storeName = 'Store') {
  const b = String(baseUrl).replace(/\/$/, '');
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const endpoints = [
    {
      method: 'GET', path: '/products', anchor: 'products',
      blurb: 'Everything on sale, priced for your account. If you have an agreed price or an allowance, you see it here — not the public price.',
      req: `curl -H "X-API-Key: $KEY" \\
  ${b}/api/v2/products`,
      res: `{
  "success": true,
  "count": 2,
  "products": [
    {
      "id": 10,
      "title": "Netflix Premium 1 Month",
      "price": 1.00,
      "public_price": 2.00,
      "stock": 47,
      "requires_email": false,
      "delivery": "instant",
      "special_price": {
        "price": 1.00,
        "units_left": 15,
        "unlimited": false
      }
    }
  ]
}`,
    },
    {
      method: 'GET', path: '/product/:id', anchor: 'product',
      blurb: 'One product. Use it to re-check stock and price right before buying.',
      req: `curl -H "X-API-Key: $KEY" \\
  ${b}/api/v2/product/10`,
      res: `{ "success": true, "product": { "id": 10, "price": 1.00, "stock": 47 } }`,
    },
    {
      method: 'GET', path: '/balance', anchor: 'balance',
      blurb: 'What you have left to spend. Also available as <code>/me</code>.',
      req: `curl -H "X-API-Key: $KEY" \\
  ${b}/api/v2/balance`,
      res: `{ "success": true, "balance": 42.75, "currency": "USD", "user_id": 123456789 }`,
    },
    {
      method: 'POST', path: '/purchase', anchor: 'purchase',
      blurb: 'Buy. Paid from your wallet balance, delivered in the response. Also available as <code>/order</code>.',
      req: `curl -X POST ${b}/api/v2/purchase \\
  -H "X-API-Key: $KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"product_id": 10, "quantity": 2}'`,
      res: `{
  "success": true,
  "order": {
    "id": 8451,
    "product_id": 10,
    "product": "Netflix Premium 1 Month",
    "quantity": 2,
    "unit_price": 1.00,
    "total": 2.00,
    "status": "delivered",
    "items": [
      "user1@mail.com:pass123",
      "user2@mail.com:pass456"
    ],
    "balance": 40.75
  }
}`,
      fields: [
        ['product_id', 'number', 'required', 'From /products'],
        ['quantity', 'number', 'optional', 'Defaults to 1. Max 100'],
        ['email', 'string', 'conditional', 'Required when the product has requires_email: true'],
      ],
    },
    {
      method: 'GET', path: '/orders', anchor: 'orders',
      blurb: 'Your purchase history, newest first.',
      req: `curl -H "X-API-Key: $KEY" \\
  "${b}/api/v2/orders?limit=20&offset=0"`,
      res: `{ "success": true, "total": 138, "orders": [ { "id": 8451, "status": "delivered", "total": 2.00 } ] }`,
    },
    {
      method: 'GET', path: '/order/:id', anchor: 'order',
      blurb: 'One order, including what was delivered. Use this if you lost a response.',
      req: `curl -H "X-API-Key: $KEY" \\
  ${b}/api/v2/order/8451`,
      res: `{ "success": true, "order": { "id": 8451, "items": ["user1@mail.com:pass123"] } }`,
    },
  ];

  const codes = [
    ['200', 'ok',   'Done',                  'The order went through. <b>Save <code>items</code> now</b> — this is the delivery.'],
    ['400', 'warn', 'Check your request',    'A field is missing or malformed. The <code>error</code> string says which.'],
    ['401', 'stop', 'Key problem',           'Missing, wrong, or disabled key. Get a fresh one from the bot.'],
    ['402', 'warn', 'Top up',                'Not enough balance. The response tells you <code>required</code> and <code>balance</code>.'],
    ['403', 'stop', 'Account suspended',     'Contact support.'],
    ['404', 'warn', 'Not found',             'That product or order does not exist, or is not yours.'],
    ['409', 'warn', 'Try smaller',           'Not enough stock. The response includes <code>available</code>.'],
    ['429', 'warn', 'Slow down',             '60 requests a minute, and one purchase at a time per key.'],
    ['500', 'stop', 'Our fault',             'Something broke on our side. Retry, then tell support.'],
  ];

  const endpointCards = endpoints.map((e) => `
    <article class="ep" id="${e.anchor}">
      <header class="ep-head">
        <span class="verb v-${e.method.toLowerCase()}">${e.method}</span>
        <h3>${esc(e.path)}</h3>
      </header>
      <p class="ep-blurb">${e.blurb}</p>
      ${e.fields ? `
      <table class="fields">
        <thead><tr><th>Field</th><th>Type</th><th></th><th>Notes</th></tr></thead>
        <tbody>
          ${e.fields.map(([n, t, r, d]) => `
            <tr>
              <td><code>${n}</code></td>
              <td class="dim">${t}</td>
              <td><span class="req req-${r}">${r}</span></td>
              <td class="dim">${d}</td>
            </tr>`).join('')}
        </tbody>
      </table>` : ''}
      <div class="pair">
        <div class="block">
          <div class="block-label">Request</div>
          <pre><code>${esc(e.req)}</code></pre>
          <button class="copy" type="button">Copy</button>
        </div>
        <div class="block">
          <div class="block-label">Response</div>
          <pre><code>${esc(e.res)}</code></pre>
          <button class="copy" type="button">Copy</button>
        </div>
      </div>
    </article>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(storeName)} — API for resellers</title>
<meta name="description" content="Buy from ${esc(storeName)} straight from your own code. Wallet-funded REST API.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root{
    --ink:#0C1820; --surface:#122430; --raise:#17303E; --line:#1E3F4F;
    --paper:#E6EEF2; --muted:#7C99A8; --dim:#5B7A8A;
    --ok:#43D6A0; --warn:#F0B341; --stop:#FF7A7A; --link:#57B6E8;
    --r:10px;
  }
  *{box-sizing:border-box}
  html{scroll-behavior:smooth; scroll-padding-top:24px}
  @media (prefers-reduced-motion:reduce){ html{scroll-behavior:auto} *{transition:none!important} }
  body{
    margin:0; background:var(--ink); color:var(--paper);
    font:400 16px/1.65 'IBM Plex Sans',system-ui,sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  code,pre,.mono{font-family:'IBM Plex Mono',ui-monospace,monospace}
  a{color:var(--link)}
  .wrap{max-width:1180px;margin:0 auto;padding:0 24px}

  /* ── Masthead: the two things you need before anything else ── */
  .top{border-bottom:1px solid var(--line);background:
    radial-gradient(1100px 380px at 12% -12%, rgba(67,214,160,.10), transparent 60%), var(--ink)}
  .top-in{padding:56px 0 44px}
  .eyebrow{font:600 12px/1 'IBM Plex Mono';letter-spacing:.16em;text-transform:uppercase;color:var(--ok);margin:0 0 18px}
  h1{font:700 clamp(30px,5vw,46px)/1.1 'IBM Plex Sans';margin:0 0 14px;letter-spacing:-.02em}
  .lede{font-size:18px;color:var(--muted);max-width:60ch;margin:0 0 32px}
  .lede b{color:var(--paper);font-weight:600}

  .facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}
  .fact{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:16px 18px;position:relative}
  .fact h4{margin:0 0 8px;font:600 11px/1 'IBM Plex Mono';letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
  .fact .val{font:500 15px/1.5 'IBM Plex Mono';color:var(--paper);word-break:break-all;padding-right:56px}

  /* ── Layout ── */
  .cols{display:grid;grid-template-columns:212px 1fr;gap:44px;padding:44px 0 80px;align-items:start}
  @media (max-width:900px){ .cols{grid-template-columns:1fr;gap:28px} nav.rail{position:static!important} }
  nav.rail{position:sticky;top:24px}
  nav.rail h5{font:600 11px/1 'IBM Plex Mono';letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin:0 0 12px}
  nav.rail a{display:flex;gap:9px;align-items:baseline;padding:7px 10px;border-radius:7px;color:var(--muted);text-decoration:none;font-size:14px}
  nav.rail a:hover,nav.rail a:focus-visible{background:var(--surface);color:var(--paper)}
  nav.rail .m{font:600 10px/1 'IBM Plex Mono';color:var(--dim)}

  section{margin:0 0 52px}
  h2{font:700 24px/1.2 'IBM Plex Sans';margin:0 0 8px;letter-spacing:-.01em}
  .sub{color:var(--muted);margin:0 0 22px;max-width:66ch}

  /* ── Endpoint cards ── */
  .ep{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:22px;margin:0 0 18px}
  .ep-head{display:flex;align-items:center;gap:12px;margin-bottom:10px;flex-wrap:wrap}
  .ep-head h3{margin:0;font:600 19px/1 'IBM Plex Mono';letter-spacing:-.01em}
  .verb{font:600 11px/1 'IBM Plex Mono';letter-spacing:.08em;padding:6px 9px;border-radius:5px}
  .v-get{background:rgba(87,182,232,.14);color:var(--link);border:1px solid rgba(87,182,232,.3)}
  .v-post{background:rgba(67,214,160,.14);color:var(--ok);border:1px solid rgba(67,214,160,.3)}
  .ep-blurb{color:var(--muted);margin:0 0 18px;max-width:70ch}
  .ep-blurb code,.codes code{background:var(--raise);padding:1px 6px;border-radius:4px;font-size:.9em;color:var(--paper)}

  .fields{width:100%;border-collapse:collapse;margin:0 0 18px;font-size:14px}
  .fields th{text-align:left;font:600 10px/1 'IBM Plex Mono';letter-spacing:.12em;text-transform:uppercase;color:var(--dim);padding:0 12px 8px 0;border-bottom:1px solid var(--line)}
  .fields td{padding:9px 12px 9px 0;border-bottom:1px solid var(--line);vertical-align:top}
  .fields tr:last-child td{border-bottom:none}
  .fields code{background:var(--raise);padding:2px 7px;border-radius:4px}
  .dim{color:var(--muted)}
  .req{font:600 10px/1 'IBM Plex Mono';letter-spacing:.08em;text-transform:uppercase;padding:4px 7px;border-radius:4px;white-space:nowrap}
  .req-required{background:rgba(255,122,122,.14);color:var(--stop)}
  .req-optional{background:rgba(124,153,168,.16);color:var(--muted)}
  .req-conditional{background:rgba(240,179,65,.14);color:var(--warn)}

  .pair{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media (max-width:820px){ .pair{grid-template-columns:1fr} }
  .block{position:relative;min-width:0}
  .block-label{font:600 10px/1 'IBM Plex Mono';letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin:0 0 8px}
  pre{background:var(--ink);border:1px solid var(--line);border-radius:8px;padding:15px 16px;margin:0;overflow-x:auto}
  pre code{font-size:13px;line-height:1.7;color:#CFE0E8;white-space:pre}
  .copy{position:absolute;top:26px;right:9px;background:var(--raise);border:1px solid var(--line);color:var(--muted);
    font:600 10px/1 'IBM Plex Mono';letter-spacing:.08em;text-transform:uppercase;padding:6px 9px;border-radius:5px;cursor:pointer}
  .copy:hover,.copy:focus-visible{color:var(--paper);border-color:var(--ok)}
  .copy.done{color:var(--ok);border-color:var(--ok)}

  /* ── Signature: the status ledger ── */
  .codes{display:grid;gap:2px;background:var(--line);border:1px solid var(--line);border-radius:var(--r);overflow:hidden}
  .code{display:grid;grid-template-columns:78px 168px 1fr;gap:16px;background:var(--surface);padding:15px 18px;align-items:baseline}
  @media (max-width:760px){ .code{grid-template-columns:64px 1fr;gap:6px 14px} .code .what{grid-column:2} .code .say{grid-column:1/-1;padding-left:0} }
  .code .num{font:600 17px/1 'IBM Plex Mono';position:relative;padding-left:13px}
  .code .num::before{content:'';position:absolute;left:0;top:-3px;bottom:-3px;width:3px;border-radius:2px}
  .code.ok   .num{color:var(--ok)}    .code.ok   .num::before{background:var(--ok)}
  .code.warn .num{color:var(--warn)}  .code.warn .num::before{background:var(--warn)}
  .code.stop .num{color:var(--stop)}  .code.stop .num::before{background:var(--stop)}
  .code .what{font-weight:600;font-size:14px}
  .code .say{color:var(--muted);font-size:14px}

  .note{border-left:3px solid var(--warn);background:rgba(240,179,65,.07);padding:15px 18px;border-radius:0 8px 8px 0;margin:22px 0}
  .note b{color:var(--warn)}
  footer{border-top:1px solid var(--line);padding:26px 0;color:var(--dim);font-size:14px}
</style>
</head>
<body>

<div class="top"><div class="wrap top-in">
  <p class="eyebrow">${esc(storeName)} · Reseller API v2</p>
  <h1>Buy from the shop in your own code.</h1>
  <p class="lede">Every customer gets a key — no application, no waiting. Open the bot,
     tap <b>🔌 API Access</b>, and it is there. Purchases come out of your
     <b>wallet balance</b>, so top up first: the API spends, it cannot take payment.</p>
  <div class="facts">
    <div class="fact">
      <h4>Base URL</h4>
      <div class="val" id="base">${esc(b)}/api/v2</div>
      <button class="copy" type="button" style="top:14px">Copy</button>
    </div>
    <div class="fact">
      <h4>Auth header</h4>
      <div class="val" id="auth">X-API-Key: sk_your_key_here</div>
      <button class="copy" type="button" style="top:14px">Copy</button>
    </div>
  </div>
</div></div>

<div class="wrap cols">
  <nav class="rail" aria-label="Endpoints">
    <h5>Endpoints</h5>
    ${endpoints.map((e) => `<a href="#${e.anchor}"><span class="m">${e.method}</span>${esc(e.path)}</a>`).join('')}
    <h5 style="margin-top:20px">Reference</h5>
    <a href="#start"><span class="m">01</span>Get started</a>
    <a href="#status"><span class="m">02</span>Status codes</a>
  </nav>

  <main>
    <section id="start">
      <h2>Get started</h2>
      <p class="sub">Three steps, in order. Skip the second one and every purchase answers 402.</p>
      <div class="codes">
        <div class="code ok"><span class="num">01</span><span class="what">Get your key</span>
          <span class="say">In the bot: <code>🔌 API Access</code>. Tap the key to copy it.</span></div>
        <div class="code ok"><span class="num">02</span><span class="what">Top up your wallet</span>
          <span class="say">In the bot: <code>💰 Wallet</code>. USDT, Binance Pay or CryptoBot.</span></div>
        <div class="code ok"><span class="num">03</span><span class="what">Call the API</span>
          <span class="say">Start with <a href="#products">GET /products</a> to see your prices.</span></div>
      </div>
      <div class="note"><b>Keep the key private.</b> Anyone holding it can spend your balance.
        If it leaks, tap <code>🔁 Generate new key</code> in the bot — the old one dies immediately.</div>
    </section>

    <section>
      <h2>Endpoints</h2>
      <p class="sub">Send your key as the <code>X-API-Key</code> header on every request.
         <code>Authorization: Bearer &lt;key&gt;</code> works too. Rate limit: 60 requests a minute.</p>
      ${endpointCards}
    </section>

    <section id="status">
      <h2>Status codes</h2>
      <p class="sub">What each one means for you, not what the spec calls it.</p>
      <div class="codes">
        ${codes.map(([n, k, what, say]) => `
        <div class="code ${k}">
          <span class="num">${n}</span>
          <span class="what">${what}</span>
          <span class="say">${say}</span>
        </div>`).join('')}
      </div>
      <div class="note"><b>Nothing is charged on a failed call.</b> If a purchase cannot go
        through, the balance is untouched and the stock stays on the shelf.</div>
    </section>
  </main>
</div>

<footer><div class="wrap">
  ${esc(storeName)} · Machine-readable version at
  <a href="${esc(b)}/api/v2/docs.json">/api/v2/docs.json</a>
</div></footer>

<script>
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.copy');
  if (!btn) return;
  const host = btn.parentElement;
  const src  = host.querySelector('pre code') || host.querySelector('.val');
  if (!src) return;
  navigator.clipboard.writeText(src.textContent.trim()).then(() => {
    const was = btn.textContent;
    btn.textContent = 'Copied';
    btn.classList.add('done');
    setTimeout(() => { btn.textContent = was; btn.classList.remove('done'); }, 1400);
  });
});
</script>
</body>
</html>`;
}

module.exports = { docsPage };
