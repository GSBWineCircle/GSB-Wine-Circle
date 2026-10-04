/* Wine Circle Passport - member side. Loaded by index.html after its own script,
   so it can use that page's globals (apiFetch, esc, setView, member).
   All user/admin-supplied text goes through esc(); interactions use data-*
   attributes and one delegated listener, never inline handlers built from data. */
(function () {
  'use strict';

  var PP = { tries: 0, retry: null, data: null, loading: false, loadError: '', tab: 'stamps', filter: 'all', eventId: null, wineId: null, draft: null, saving: false, opening: false, uid: 0 };
  var $ = function (id) { return document.getElementById(id); };

  // ── Data helpers ──────────────────────────────────────────────────────────
  function events() { return (PP.data && PP.data.events) || []; }
  function allWines() { var out = []; events().forEach(function (e) { e.wines.forEach(function (w) { out.push(w); }); }); return out; }
  function findWine(id) { var all = allWines(); for (var i = 0; i < all.length; i++) if (all[i].wine_id === id) return all[i]; return null; }
  function eventOfWine(id) { var ev = events(); for (var i = 0; i < ev.length; i++) for (var j = 0; j < ev[i].wines.length; j++) if (ev[i].wines[j].wine_id === id) return ev[i]; return null; }
  function fmtDate(d) {
    if (!d) return '';
    return new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });
  }
  function toast(msg) {
    var t = $('pp-toast'); if (!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove('show'); }, 2400);
  }
  function banner(msg) { var b = $('pp-banner'); if (!b) return; b.textContent = msg || ''; b.style.display = msg ? 'block' : 'none'; }
  var WORDS = ['', 'Not for me', 'It was fine', 'Pleasant', 'Really good', 'Unforgettable'];

  // ── Flags (flat inline SVG; identical on every device, unlike emoji) ──────
  var C = { red: '#b8323f', blue: '#2b4a85', green: '#2f7a4f', white: '#f6f3ec', yellow: '#e2b53c', black: '#222126', ptgreen: '#2f6b45', esred: '#b3262f', sky: '#7fb0d6' };
  var COUNTRY_CODES = {
    france: 'FR', italy: 'IT', germany: 'DE', spain: 'ES', portugal: 'PT', austria: 'AT', hungary: 'HU', argentina: 'AR', chile: 'CL',
    usa: 'US', 'u.s.a.': 'US', us: 'US', 'united states': 'US', 'united states of america': 'US', america: 'US', california: 'US',
    australia: 'AU', 'new zealand': 'NZ', 'south africa': 'ZA', greece: 'GR', switzerland: 'CH', canada: 'CA', uruguay: 'UY', georgia: 'GE', lebanon: 'LB', israel: 'IL', croatia: 'HR', slovenia: 'SI', romania: 'RO', bulgaria: 'BG', england: 'GB', 'united kingdom': 'GB', uk: 'GB', japan: 'JP', china: 'CN', mexico: 'MX', brazil: 'BR', peru: 'PE', turkey: 'TR', morocco: 'MA'
  };
  function countryCode(name) {
    var k = String(name || '').trim().toLowerCase();
    return COUNTRY_CODES[k] || k.replace(/[^a-z]/g, '').slice(0, 2).toUpperCase() || '??';
  }
  function flagSvg(cc) {
    var r = function (x, y, w, h, f) { return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="' + f + '"/>'; };
    var body;
    switch (cc) {
      case 'FR': body = r(0, 0, 8, 24, C.blue) + r(8, 0, 8, 24, C.white) + r(16, 0, 8, 24, C.red); break;
      case 'IT': body = r(0, 0, 8, 24, C.green) + r(8, 0, 8, 24, C.white) + r(16, 0, 8, 24, C.red); break;
      case 'DE': body = r(0, 0, 24, 8, C.black) + r(0, 8, 24, 8, C.red) + r(0, 16, 24, 8, C.yellow); break;
      case 'ES': body = r(0, 0, 24, 6, C.esred) + r(0, 6, 24, 12, C.yellow) + r(0, 18, 24, 6, C.esred); break;
      case 'AT': body = r(0, 0, 24, 8, C.red) + r(0, 8, 24, 8, C.white) + r(0, 16, 24, 8, C.red); break;
      case 'HU': body = r(0, 0, 24, 8, C.red) + r(0, 8, 24, 8, C.white) + r(0, 16, 24, 8, C.green); break;
      case 'AR': body = r(0, 0, 24, 8, C.sky) + r(0, 8, 24, 8, C.white) + r(0, 16, 24, 8, C.sky) + '<circle cx="12" cy="12" r="2.2" fill="' + C.yellow + '"/>'; break;
      case 'CL': body = r(0, 0, 24, 12, C.white) + r(0, 12, 24, 12, C.red) + r(0, 0, 10, 12, C.blue); break;
      case 'ZA': body = r(0, 0, 24, 12, C.red) + r(0, 12, 24, 12, '#2b4a85') +
        '<path d="M-1 -1L10 12L-1 25M10 12H25" fill="none" stroke="' + C.white + '" stroke-width="7.4"/>' +
        '<path d="M-1 -1L10 12L-1 25M10 12H25" fill="none" stroke="' + C.green + '" stroke-width="4.2"/>' +
        '<path d="M0 3.2V20.8L8 12Z" fill="' + C.yellow + '"/><path d="M0 5.8V18.2L5.4 12Z" fill="' + C.black + '"/>'; break;
      case 'PT': body = r(0, 0, 9.6, 24, C.ptgreen) + r(9.6, 0, 14.4, 24, C.red) + '<circle cx="9.6" cy="12" r="3.9" fill="none" stroke="' + C.yellow + '" stroke-width="1.3"/>' + r(8, 10.2, 3.2, 3.6, C.white); break;
      case 'US': {
        var h = 24 / 7, stripes = r(0, 0, 24, 24, C.white), dots = '';
        for (var i = 0; i < 4; i++) stripes += r(0, i * 2 * h, 24, h, C.red);
        [3, 6.2, 9.4].forEach(function (x) { [2.6, 6.4, 10.2].forEach(function (y) { dots += '<circle cx="' + x + '" cy="' + y + '" r=".65" fill="' + C.white + '"/>'; }); });
        body = stripes + r(0, 0, 11.6, 4 * h, C.blue) + dots; break;
      }
      default: body = r(0, 0, 24, 24, '#cfc7b8') + '<text x="12" y="15" text-anchor="middle" font-family="Figtree,sans-serif" font-size="8" font-weight="600" fill="#6d645b">' + esc(cc) + '</text>';
    }
    return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + body + '</svg>';
  }

  // ── Bottle illustration (used when a wine has no photo) ───────────────────
  var GLASS = { red: ['#2b352c', '#171e19'], white: ['#aab68c', '#86946a'], sparkling: ['#323d2c', '#1d2619'], rose: ['#c9a09a', '#a67d77'], dessert: ['#b89c4a', '#8f7634'], fortified: ['#2b352c', '#171e19'] };
  var SHAPES = {
    bordeaux: { d: 'M43 6H57V16H56.5V72C56.5 84 82 90 82 118V270Q82 290 62 290H38Q18 290 18 270V118C18 90 43.5 84 43.5 72V16H43Z', lab: [27, 158, 46, 84], foil: 44 },
    burgundy: { d: 'M43 6H57V16V78C57 100 84 112 84 142V272Q84 292 64 292H36Q16 292 16 272V142C16 112 43 100 43 78V16Z', lab: [24, 172, 52, 86], foil: 44 },
    champagne: { d: 'M42 6H58V30C58 70 88 96 88 150V274Q88 294 68 294H32Q12 294 12 274V150C12 96 42 70 42 30Z', lab: [20, 176, 60, 82], foil: 84 },
    slim: { d: 'M44 6H56V90C56 120 72 130 72 160V272Q72 292 56 292H44Q28 292 28 272V160C28 130 44 120 44 90Z', lab: [33, 170, 34, 84], foil: 34 }
  };
  function shapeFor(w) {
    var t = (w.grape + ' ' + w.region + ' ' + w.name).toLowerCase();
    if (w.style === 'sparkling') return 'champagne';
    if (w.style === 'dessert' || /riesling|gew[uü]rz|albari|gr[uü]ner/.test(t)) return 'slim';
    if (/pinot noir|burgundy|bourgogne|chardonnay|nebbiolo|barolo|syrah|rh[oô]ne/.test(t) || w.style === 'rose' || w.style === 'white') return 'burgundy';
    return 'bordeaux';
  }
  function bottleSvg(w) {
    var s = SHAPES[shapeFor(w)], id = 'pb' + (++PP.uid), g = GLASS[w.style] || GLASS.red, lx = s.lab[0], ly = s.lab[1], lw = s.lab[2], lh = s.lab[3];
    var ink = '#4a1a26', cx = lx + lw / 2;
    var foil = w.style === 'sparkling' ? '#b08d57' : (w.style === 'white' ? '#bda977' : '#5a1827');
    var initial = ((w.producer || w.name || 'W').replace(/^(Château|Chateau|Domaine|Maison|Champagne|Weingut|Bodegas?|Cascina|Fattoria|Tenuta|Cantina|Viña|Quinta|Domäne)\s+/i, '')[0] || 'W').toUpperCase();
    var top = w.style === 'sparkling' ? 'BRUT' : String(w.region || w.grape || '').split(' ')[0].toUpperCase().slice(0, 9);
    return '<svg class="pp-bottle" viewBox="0 0 100 300" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs>' +
      '<clipPath id="c' + id + '"><path d="' + s.d + '"/></clipPath>' +
      '<linearGradient id="g' + id + '" x1="0" x2="1"><stop offset="0" stop-color="' + g[1] + '"/><stop offset=".35" stop-color="' + g[0] + '"/><stop offset=".7" stop-color="' + g[0] + '"/><stop offset="1" stop-color="' + g[1] + '"/></linearGradient></defs>' +
      '<path d="' + s.d + '" fill="url(#g' + id + ')"/><g clip-path="url(#c' + id + ')">' +
      '<rect x="0" y="0" width="100" height="' + s.foil + '" fill="' + foil + '"/><rect x="0" y="' + (s.foil - 2) + '" width="100" height="2" fill="rgba(0,0,0,.28)"/>' +
      '<rect x="' + lx + '" y="' + ly + '" width="' + lw + '" height="' + lh + '" rx="1.5" fill="#efe6d3"/>' +
      '<rect x="' + (lx + 3.5) + '" y="' + (ly + 3.5) + '" width="' + (lw - 7) + '" height="' + (lh - 7) + '" rx="1" fill="none" stroke="' + ink + '" stroke-width=".5" opacity=".55"/>' +
      '<text x="' + cx + '" y="' + (ly + 16) + '" text-anchor="middle" font-size="4.6" font-family="Georgia,serif" letter-spacing="1" fill="' + ink + '" opacity=".8">' + esc(top) + '</text>' +
      '<text x="' + cx + '" y="' + (ly + 42) + '" text-anchor="middle" font-size="24" font-family="Georgia,serif" font-style="italic" fill="' + ink + '">' + esc(initial) + '</text>' +
      '<line x1="' + (lx + 12) + '" x2="' + (lx + lw - 12) + '" y1="' + (ly + 51) + '" y2="' + (ly + 51) + '" stroke="' + ink + '" stroke-width=".5" opacity=".55"/>' +
      '<text x="' + cx + '" y="' + (ly + 62) + '" text-anchor="middle" font-size="4.8" font-family="Georgia,serif" fill="' + ink + '" opacity=".9">' + esc(w.vintage || '') + '</text>' +
      '<text x="' + cx + '" y="' + (ly + 72) + '" text-anchor="middle" font-size="3.4" font-family="Georgia,serif" letter-spacing=".8" fill="' + ink + '" opacity=".65">' + esc(String(w.country || '').toUpperCase().slice(0, 14)) + '</text>' +
      '<path d="M' + (lx - 4) + ' 0V300" stroke="rgba(255,255,255,.22)" stroke-width="6" transform="translate(6 0)"/></g></svg>';
  }
  function bottleHtml(w) {
    if (w.image_url) return '<img class="pp-bottle" src="' + esc(w.image_url) + '" alt="' + esc(w.name) + '" data-wine="' + esc(w.wine_id) + '">';
    return bottleSvg(w);
  }

  // ── Stamp (generated from the server's stamp spec) ────────────────────────
  var MOTIFS = {
    grapes: '<g fill="none"><circle cx="-12" cy="-6" r="5.6"/><circle cx="0" cy="-6" r="5.6"/><circle cx="12" cy="-6" r="5.6"/><circle cx="-6" cy="5" r="5.6"/><circle cx="6" cy="5" r="5.6"/><circle cx="0" cy="16" r="5.6"/><path d="M0 -12C0 -20 6 -24 14 -23"/></g><path d="M2 -16C4 -26 12 -30 20 -28C18 -20 12 -16 2 -16Z" stroke="none"/>',
    bubbles: '<g fill="none"><path d="M-14 -10H14C14 4 6 10 0 10C-6 10 -14 4 -14 -10Z"/><path d="M0 10V22M-9 24H9"/><circle cx="-6" cy="-19" r="2"/><circle cx="3" cy="-24" r="2.4"/><circle cx="9" cy="-18" r="1.6"/></g>',
    heart: '<path d="M0 18C-26 0 -20 -20 -8 -18C-3 -17 0 -12 0 -10C0 -12 3 -17 8 -18C20 -20 26 0 0 18Z" stroke="none"/>',
    snow: '<g fill="none"><path d="M-22 0H22M-11 -19L11 19M-11 19L11 -19"/><circle cx="-22" cy="0" r="2"/><circle cx="22" cy="0" r="2"/><circle cx="-11" cy="-19" r="2"/><circle cx="11" cy="19" r="2"/><circle cx="-11" cy="19" r="2"/><circle cx="11" cy="-19" r="2"/></g>',
    sun: '<g fill="none"><circle cx="0" cy="0" r="9"/><path d="M0 -24V-15M0 15V24M-24 0H-15M15 0H24M-17 -17L-11 -11M11 11L17 17M-17 17L-11 11M11 -11L17 -17"/></g>',
    wave: '<g fill="none"><path d="M-24 -10q6 -8 12 0t12 0t12 0t12 0"/><path d="M-24 2q6 -8 12 0t12 0t12 0t12 0"/><path d="M-24 14q6 -8 12 0t12 0t12 0t12 0"/></g>',
    mountain: '<path d="M-26 18L-8 -12L2 4L10 -6L26 18Z" stroke="none"/><circle cx="14" cy="-18" r="4" fill="none"/>',
    leaf: '<g fill="none"><path d="M-16 14C-20 -8 0 -22 20 -20C22 0 8 18 -16 14Z"/><path d="M-16 14L8 -8"/></g>',
    barrel: '<g fill="none"><path d="M-16 -20C-26 -8 -26 8 -16 20H16C26 8 26 -8 16 -20Z"/><path d="M-23 -9H23M-23 9H23"/></g>',
    moon: '<path d="M10 -22A22 22 0 1 0 22 10A17 17 0 1 1 10 -22Z" stroke="none"/><circle cx="16" cy="-14" r="2" stroke="none"/>',
    globe: '<g fill="none"><circle cx="0" cy="0" r="20"/><ellipse cx="0" cy="0" rx="9" ry="20"/><path d="M-20 0H20M-17 -10Q0 -4 17 -10M-17 10Q0 4 17 10"/></g>',
    vineyard: '<g fill="none"><path d="M-26 8Q-10 -8 6 2T28 -2"/><path d="M-26 22Q-8 8 10 14T28 10"/></g><circle cx="12" cy="-16" r="5" stroke="none"/>',
    volcano: '<g fill="none"><path d="M-24 22L-8 -8H8L24 22Z"/><path d="M0 -12Q-6 -17 0 -21Q6 -25 1 -28"/></g>',
    chateau: '<g fill="none"><path d="M-22 22V-2H-16V-8H-10V-2H-4V-14H4V-2H10V-8H16V-2H22V22Z"/><path d="M-4 -14L0 -25L4 -14"/><path d="M-5 22V12Q0 6 5 12V22"/></g>',
    river: '<g fill="none"><path d="M-8 -26C12 -16 -14 -4 4 8S2 18 8 26"/><path d="M2 -26C22 -16 -4 -4 14 8S12 18 18 26"/></g>',
    palm: '<g fill="none"><path d="M0 22Q-2 6 4 -8"/><path d="M4 -8Q-8 -12 -16 -4M4 -8Q-4 -20 -14 -18M4 -8Q8 -22 18 -18M4 -8Q16 -12 20 -2"/><path d="M-14 22H14"/></g>',
    olive: '<g fill="none"><path d="M-16 14Q4 4 18 -12"/></g><g stroke="none"><ellipse cx="-10" cy="5" rx="7" ry="3" transform="rotate(-60 -10 5)"/><ellipse cx="-6" cy="15" rx="7" ry="3" transform="rotate(20 -6 15)"/><ellipse cx="2" cy="-6" rx="7" ry="3" transform="rotate(-70 2 -6)"/><ellipse cx="6" cy="6" rx="7" ry="3" transform="rotate(15 6 6)"/><ellipse cx="12" cy="-16" rx="7" ry="3" transform="rotate(-55 12 -16)"/><ellipse cx="17" cy="-4" rx="7" ry="3" transform="rotate(20 17 -4)"/></g>',
    cypress: '<path d="M0 -26C10 -10 10 8 4 20H-4C-10 8 -10 -10 0 -26Z" stroke="none"/><path d="M-26 24Q-10 16 0 24T26 22" fill="none"/>',
    pine: '<path d="M0 -26L-12 -6H-5L-15 10H-6L-18 22H18L6 10H15L5 -6H12Z" stroke="none"/><path d="M0 22V28" fill="none"/>',
    cheese: '<g fill="none"><path d="M-24 16L-24 4L24 -14V16Z"/><circle cx="-8" cy="9" r="2.6"/><circle cx="8" cy="3" r="2.6"/><circle cx="14" cy="11" r="2.2"/></g>',
    fish: '<g fill="none"><path d="M-24 0C-12 -14 8 -14 16 0C8 14 -12 14 -24 0Z"/><path d="M16 0L26 -10V10Z"/></g><circle cx="-14" cy="-2" r="1.8" stroke="none"/>',
    cake: '<g fill="none"><path d="M-20 22V6H20V22Z"/><path d="M-20 14Q-10 20 0 14T20 14"/><path d="M-14 6V-4H14V6"/><path d="M-6 -4V-12M6 -4V-12"/></g><path d="M-6 -14Q-9 -18 -6 -21Q-3 -18 -6 -14ZM6 -14Q3 -18 6 -21Q9 -18 6 -14Z" stroke="none"/>',
    star: '<path d="M0 -24L5.9 -8.1L22.8 -7.4L9.5 3.1L14.1 19.4L0 10L-14.1 19.4L-9.5 3.1L-22.8 -7.4L-5.9 -8.1Z"/>',
    compass: '<g fill="none"><circle cx="0" cy="0" r="22"/><path d="M0 -22V-17M0 17V22M-22 0H-17M17 0H22"/></g><path d="M9 -9L2 2L-9 9L-2 -2Z" stroke="none"/>',
    question: '<path d="M-9 -12C-9 -24 11 -24 11 -12C11 -4 0 -4 0 6" fill="none"/><circle cx="0" cy="17" r="2.4" stroke="none"/>',
    bottle: '<g fill="none"><path d="M-4 -26H4V-12C4 -6 11 -4 11 6V24H-11V6C-11 -4 -4 -6 -4 -12Z"/><path d="M-11 9H11M-11 19H11"/></g>',
    note: '<g fill="none"><path d="M-6 16V-18L14 -22V10"/><path d="M-6 -10L14 -14"/></g><ellipse cx="-11" cy="16" rx="6" ry="4.5" stroke="none"/><ellipse cx="9" cy="10" rx="6" ry="4.5" stroke="none"/>',
    book: '<g fill="none"><path d="M0 -14C-8 -18 -18 -18 -24 -16V16C-18 14 -8 14 0 18C8 14 18 14 24 16V-16C18 -18 8 -18 0 -14Z"/><path d="M0 -14V18"/></g>',
    hourglass: '<g fill="none"><path d="M-12 -22H12C12 -8 2 -2 0 0C2 2 12 8 12 22H-12C-12 8 -2 2 0 0C-2 -2 -12 -8 -12 -22Z"/></g><path d="M-6 19H6L0 11Z" stroke="none"/>',
    flame: '<path d="M0 24C-14 24 -18 12 -12 2C-10 -4 -4 -8 -2 -24C8 -14 16 -4 14 8C13 18 8 24 0 24Z" fill="none"/><path d="M0 24C-6 24 -8 18 -4 12C-2 8 0 6 0 2C6 8 8 14 6 18C5 22 3 24 0 24Z" stroke="none"/>',
    crown: '<g fill="none"><path d="M-22 18L-26 -10L-10 2L0 -16L10 2L26 -10L22 18Z"/><path d="M-22 24H22"/></g>',
    flower: '<g fill="none"><circle cx="0" cy="0" r="4"/><ellipse cx="0" cy="-12" rx="5" ry="8"/><ellipse cx="0" cy="-12" rx="5" ry="8" transform="rotate(60)"/><ellipse cx="0" cy="-12" rx="5" ry="8" transform="rotate(120)"/><ellipse cx="0" cy="-12" rx="5" ry="8" transform="rotate(180)"/><ellipse cx="0" cy="-12" rx="5" ry="8" transform="rotate(240)"/><ellipse cx="0" cy="-12" rx="5" ry="8" transform="rotate(300)"/></g>'
  };
  // Faint background scenes drawn inside the medallion (coordinates centred on 0,0; radius ~35).
  function sceneSvg(id) {
    var i, a, out = '';
    switch (id) {
      case 'rays':
        for (i = 0; i < 24; i++) {
          a = i * Math.PI / 12; var r2 = i % 2 ? 26 : 36;
          out += '<line x1="' + (Math.cos(a) * 13).toFixed(1) + '" y1="' + (Math.sin(a) * 13).toFixed(1) + '" x2="' + (Math.cos(a) * r2).toFixed(1) + '" y2="' + (Math.sin(a) * r2).toFixed(1) + '" stroke-width=".8"/>';
        }
        return out;
      case 'stars': {
        var sp = function (x, y, k) { return '<path transform="translate(' + x + ' ' + y + ') scale(' + k + ')" d="M0 -4L1 -1L4 0L1 1L0 4L-1 1L-4 0L-1 -1Z" stroke="none"/>'; };
        out = sp(-22, -20, 1) + sp(20, -24, .8) + sp(26, 4, .6) + sp(-27, 8, .7) + sp(-8, -30, .6) + sp(12, 24, .7);
        [[-14, 18], [8, -14], [28, -12], [-30, -6], [2, 30], [-20, 28], [18, 12], [-4, -22]].forEach(function (p) { out += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="1" stroke="none"/>'; });
        return out;
      }
      case 'sun':
        out = '<circle cx="19" cy="-17" r="8" stroke="none"/>';
        for (i = 0; i < 10; i++) { a = i * Math.PI / 5; out += '<line x1="' + (19 + Math.cos(a) * 11).toFixed(1) + '" y1="' + (-17 + Math.sin(a) * 11).toFixed(1) + '" x2="' + (19 + Math.cos(a) * 15).toFixed(1) + '" y2="' + (-17 + Math.sin(a) * 15).toFixed(1) + '" stroke-width="1.1"/>'; }
        return out;
      case 'moon':
        return '<path transform="translate(-19 -16) scale(.5)" d="M10 -22A22 22 0 1 0 22 10A17 17 0 1 1 10 -22Z" stroke="none"/>' +
          '<circle cx="14" cy="-22" r="1.2" stroke="none"/><circle cx="24" cy="-8" r="1" stroke="none"/><circle cx="-4" cy="-28" r="1" stroke="none"/><circle cx="26" cy="12" r="1.1" stroke="none"/>';
      case 'hills':
        return '<path d="M-36 36V14Q-20 2 -4 12T36 6V36Z" stroke="none" opacity=".7"/><path d="M-36 36V26Q-14 14 8 23T36 19V36Z" stroke="none"/>';
      case 'waves':
        for (i = 0; i < 4; i++) { var y = 12 + i * 7; out += '<path d="M-36 ' + y + 'q6 -5 12 0t12 0t12 0t12 0t12 0t12 0" fill="none" stroke-width="1"/>'; }
        return out;
      case 'rows':
        return '<path d="M-36 8H36" fill="none" stroke-width=".8"/><path d="M-34 36L-4 8M-17 36L-2 8M0 36V8M17 36L2 8M34 36L4 8" fill="none" stroke-width=".9"/>';
      case 'snow':
        [[-24, -18], [-8, -26], [10, -22], [26, -14], [-30, 0], [-14, -6], [4, -10], [20, 0], [30, 14], [-22, 14], [-4, 10], [14, 18], [-12, 26], [8, 30], [26, 28]].forEach(function (p, k) { out += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="' + (k % 3 ? 1.1 : 1.7) + '" stroke="none"/>'; });
        return out;
    }
    return '';
  }

  function stampSvg(st, big) {
    var u = 'ps' + (++PP.uid), c = st.color || '#5a1827';
    var label = esc(st.label || ''), len = Math.max((st.label || '').length, 1);
    var fs = Math.max(5.5, Math.min(9, 135 / (len * 0.91)));
    var spark = function (x) { return '<path transform="translate(' + x + ' 70) scale(.9)" d="M0 -4L1 -1L4 0L1 1L0 4L-1 1L-4 0L-1 -1Z" stroke="none"/>'; };
    return '<svg ' + (big ? 'class="pp-big" ' : '') + 'viewBox="0 0 140 140" role="img" aria-label="' + label + ' stamp"><defs>' +
      '<path id="t' + u + '" d="M 22,70 A 48,48 0 0 1 118,70"/><path id="b' + u + '" d="M 12,70 A 58,58 0 0 0 128,70"/>' +
      '<clipPath id="m' + u + '"><circle cx="70" cy="70" r="35.5"/></clipPath></defs>' +
      '<g fill="' + c + '" stroke="' + c + '">' +
      // outer ornament: bold ring, a ring of dots, a hairline
      '<circle cx="70" cy="70" r="66" fill="none" stroke-width="1.5"/>' +
      '<circle cx="70" cy="70" r="63.2" fill="none" stroke-width="1.6" stroke-dasharray=".1 3.2" stroke-linecap="round"/>' +
      '<circle cx="70" cy="70" r="60.5" fill="none" stroke-width=".55"/>' +
      // medallion: tint, double ring, scene, then the icon on top
      '<circle cx="70" cy="70" r="39" fill="' + c + '" fill-opacity=".07" stroke-width="1.1"/>' +
      '<circle cx="70" cy="70" r="36.3" fill="none" stroke-width=".4"/>' +
      '<g clip-path="url(#m' + u + ')"><g transform="translate(70 70)" opacity=".3">' + sceneSvg(st.accent) + '</g></g>' +
      '<text font-family="Figtree,sans-serif" font-weight="600" font-size="' + fs.toFixed(1) + '" letter-spacing="' + (fs * 0.25).toFixed(1) + '" stroke="none" text-anchor="middle"><textPath href="#t' + u + '" startOffset="50%">' + label + '</textPath></text>' +
      '<text font-family="Figtree,sans-serif" font-weight="500" font-size="7.2" letter-spacing="2.4" stroke="none" text-anchor="middle"><textPath href="#b' + u + '" startOffset="50%">' + esc(st.dateLabel || '') + '</textPath></text>' +
      spark(15.5) + spark(124.5) +
      '<g transform="translate(70 70) scale(.88)" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">' + (MOTIFS[st.motif] || MOTIFS.grapes) + '</g>' +
      '</g></svg>';
  }

  var glassSvg = '<svg viewBox="0 0 40 48" aria-hidden="true"><path class="bowl" d="M9 3h22c1 14-2 24-11 26C11 27 8 17 9 3Z"/><path class="stem" d="M20 29v13M12 44h16"/></svg>';
  function miniGlass(on) { return '<svg viewBox="0 0 16 20" class="pp-mg' + (on ? ' on' : '') + '" aria-hidden="true"><path d="M3 1h10c.4 6-1 10-5 11C4 11 2.6 7 3 1Z"/><path d="M8 12v6M4.5 19h7"/></svg>'; }

  // ── Views ─────────────────────────────────────────────────────────────────
  function renderStats() {
    var ws = allWines(), rated = ws.filter(function (w) { return w.my.rating; });
    var avg = rated.length ? (rated.reduce(function (s, w) { return s + w.my.rating; }, 0) / rated.length).toFixed(1) : '–';
    var countries = [], codes = {};
    ws.forEach(function (w) { var k = String(w.country || '').trim(); if (k && !codes[k.toLowerCase()]) { codes[k.toLowerCase()] = 1; countries.push(k); } });
    var seen = {}, flags = [];
    countries.forEach(function (c) { var cc = countryCode(c); if (!seen[cc]) { seen[cc] = 1; flags.push('<span class="pp-fl" title="' + esc(c) + '" role="img" aria-label="' + esc(c) + '">' + flagSvg(cc) + '</span>'); } });
    $('pp-stats').innerHTML =
      '<div class="pp-stat"><b>' + events().length + '</b><span>Events attended</span></div>' +
      '<div class="pp-stat"><b>' + ws.length + '</b><span>Wines tasted</span></div>' +
      '<div class="pp-stat"><b>' + flags.length + '</b><span>Countries</span></div>' +
      '<div class="pp-stat"><b>' + avg + '</b><span>Avg. rating · ' + rated.length + ' rated</span></div>';
    $('pp-flags').innerHTML = flags.length ? '<span>Explored</span>' + flags.join('') : '';
  }

  function renderStamps() {
    if (PP.loading && !PP.data) { $('pp-page').innerHTML = '<div class="pp-empty">Opening your passport…</div>'; return; }
    if (PP.loadError) { $('pp-page').innerHTML = '<div class="pp-empty">' + esc(PP.loadError) + '</div>'; return; }
    if (!events().length) { $('pp-page').innerHTML = '<div class="pp-empty">Your stamps appear here after you attend an event.</div>'; return; }
    var cards = events().map(function (e) {
      var n = e.wines.length, rated = e.wines.filter(function (w) { return w.my.rating; }).length;
      var pill = !n ? '' : (rated === n ? '<span class="pp-state done"><i></i>All rated</span>' : '<span class="pp-state todo"><i></i>' + (n - rated) + ' to rate</span>');
      return '<button type="button" class="pp-stamp-card" data-act="event" data-id="' + esc(e.event_id) + '">' + stampSvg(e.stamp) +
        '<div class="pp-lbl">' + esc(e.name) + '</div><div class="pp-meta">' + esc(fmtDate(e.event_date)) + '</div>' + pill + '</button>';
    }).join('');
    $('pp-page').innerHTML = '<div class="pp-stamps">' + cards + '</div>';
  }

  function wineCard(w) {
    var r = w.my.rating || 0;
    return '<button type="button" class="pp-wine-card" data-act="wine" data-id="' + esc(w.wine_id) + '">' + bottleHtml(w) +
      '<div class="pp-wn">' + esc(w.name) + '</div><div class="pp-wp">' + esc([w.producer, w.vintage].filter(Boolean).join(' · ')) + '</div>' +
      '<div class="pp-mini">' + (r ? [1, 2, 3, 4, 5].map(function (n) { return miniGlass(n <= r); }).join('') : '<span class="pp-norate">Not rated</span>') + '</div></button>';
  }

  function showEvent(id) {
    var e = events().filter(function (x) { return x.event_id === id; })[0];
    if (!e) return setTab('stamps');
    PP.eventId = id;
    var meta = esc(fmtDate(e.event_date)) + (e.location ? '<br>' + esc(e.location) : '') + (e.wines.length ? '<br>' + e.wines.length + ' wine' + (e.wines.length === 1 ? '' : 's') + ' poured' : '');
    $('pp-page').innerHTML =
      '<button type="button" class="pp-back" data-act="tab" data-id="stamps">← All stamps</button>' +
      '<div class="pp-spread"><div class="pp-left">' + stampSvg(e.stamp, true) +
      '<div class="pp-ev-name">' + esc(e.name) + '</div><div class="pp-ev-meta">' + meta + '</div>' +
      (e.blurb ? '<div class="pp-blurb">' + esc(e.blurb) + '</div>' : '') + '</div>' +
      '<div class="pp-right"><div class="pp-section-title">The flight</div>' +
      (e.wines.length
        ? '<div class="pp-section-sub">Select a bottle to see the details and add your rating and tasting notes.</div><div class="pp-flight">' + e.wines.map(wineCard).join('') + '</div>'
        : '<div class="pp-empty" style="text-align:left;padding:20px 0">No wine list was recorded for this event.</div>') +
      '</div></div>';
    var tabs = document.querySelector('#pp-app .pp-tabs');
    if (tabs) window.scrollTo({ top: tabs.offsetTop, behavior: 'smooth' });
  }

  function renderCellar() {
    var ws = allWines();
    var f = PP.filter;
    if (f === 'red' || f === 'white' || f === 'sparkling') ws = ws.filter(function (w) { return w.style === f; });
    if (f === 'other') ws = ws.filter(function (w) { return ['red', 'white', 'sparkling'].indexOf(w.style) < 0; });
    if (f === 'top') ws = ws.filter(function (w) { return w.my.rating >= 5; });
    if (f === 'unrated') ws = ws.filter(function (w) { return !w.my.rating; });
    var chips = [['all', 'All'], ['red', 'Red'], ['white', 'White'], ['sparkling', 'Sparkling'], ['other', 'Other'], ['top', 'Favorites'], ['unrated', 'Still to rate']]
      .map(function (p) { return '<button type="button" class="pp-chip' + (f === p[0] ? ' on' : '') + '" data-act="filter" data-id="' + p[0] + '">' + p[1] + '</button>'; }).join('');
    var per = window.innerWidth < 720 ? 3 : 6, rows = '';
    for (var i = 0; i < ws.length; i += per) rows += '<div class="pp-shelf">' + ws.slice(i, i + per).map(wineCard).join('') + '</div>';
    var empty = !allWines().length ? 'Wines you taste at events appear here.' : 'Nothing here yet — try another filter.';
    $('pp-page').innerHTML = '<div class="pp-filters">' + chips + '</div>' + (rows || '<div class="pp-empty">' + empty + '</div>');
  }

  function setTab(t) {
    PP.tab = t; PP.eventId = null;
    document.querySelectorAll('#pp-app .pp-tab').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-id') === t); });
    if (t === 'cellar') renderCellar(); else renderStamps();
  }
  function rerender() {
    renderStats();
    if (PP.eventId) showEvent(PP.eventId); else setTab(PP.tab);
  }

  // ── Wine sheet ────────────────────────────────────────────────────────────
  function normTag(s) {
    s = String(s || '').replace(/<[^>]*>/g, ' ').toLowerCase().replace(/[^\p{L}\p{N}\s'&-]/gu, ' ').replace(/\s+/g, ' ').trim().replace(/^[-'&]+|[-'&]+$/g, '').trim();
    return (s.length >= 2 && s.length <= 24) ? s : null;
  }
  function openWine(id) {
    var w = findWine(id), e = eventOfWine(id);
    if (!w || !e) return;
    PP.wineId = id;
    PP.draft = { rating: w.my.rating || 0, tags: (w.my.tags || []).slice(), note: w.my.note || '', share: !!w.my.share_tags };
    var style = ({ rose: 'Rosé', dessert: 'Dessert', fortified: 'Fortified', sparkling: 'Sparkling', white: 'White', red: 'Red' })[w.style] || w.style;
    var facts = '<dt>Origin</dt><dd>' + esc([w.region, w.country].filter(Boolean).join(', ') || '—') + '</dd>' +
      (w.grape ? '<dt>Grape</dt><dd>' + esc(w.grape) + '</dd>' : '') + '<dt>Style</dt><dd>' + esc(style) + '</dd><dt>Poured at</dt><dd>' + esc(e.name) + '</dd>';
    $('pp-sheet').innerHTML =
      '<button type="button" class="pp-x" data-act="close-wine" aria-label="Close">✕</button>' +
      '<div class="pp-stage">' + bottleHtml(w) + '<div class="pp-vint">' + (w.vintage ? 'Vintage ' + esc(w.vintage) : '') + '</div></div>' +
      '<div class="pp-sbody"><h3>' + esc(w.name) + '</h3>' + (w.producer ? '<div class="pp-prod">' + esc(w.producer) + '</div>' : '') +
      '<dl class="pp-facts">' + facts + '</dl>' +
      '<div class="pp-label">Your rating</div><div class="pp-glasses" id="pp-glasses"></div>' +
      '<div class="pp-label">What did you taste? <small>Suggestions from research on this wine, plus tags from other members.</small></div>' +
      '<div class="pp-tagbox" id="pp-tagbox"></div>' +
      '<div class="pp-addtag"><input type="text" id="pp-newtag" maxlength="24" placeholder="Add your own tag" aria-label="Add your own tag"><button type="button" data-act="add-tag">Add</button></div>' +
      '<label class="pp-share"><input type="checkbox" id="pp-share"' + (PP.draft.share ? ' checked' : '') + '><span>Show my tags to other members as optional tags (anonymously). Your notes always stay private.</span></label>' +
      '<div class="pp-label">Your tasting notes</div><textarea id="pp-notes" maxlength="2000" placeholder="Colour, nose, palate, finish — or simply what you thought."></textarea>' +
      '<div class="pp-save-row"><button type="button" class="pp-btn" id="pp-save" data-act="save-wine">Save to passport</button><span class="pp-saved" id="pp-saved">Only you can see your notes</span></div></div>';
    $('pp-notes').value = PP.draft.note;
    $('pp-notes').addEventListener('input', function (ev) { PP.draft.note = ev.target.value; });
    $('pp-share').addEventListener('change', function (ev) { PP.draft.share = ev.target.checked; });
    $('pp-newtag').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); addTag(); } });
    drawGlasses(); drawTags();
    $('pp-overlay').classList.add('open'); document.body.style.overflow = 'hidden';
  }
  function drawGlasses() {
    $('pp-glasses').innerHTML = [1, 2, 3, 4, 5].map(function (n) {
      return '<button type="button" class="pp-glass' + (n <= PP.draft.rating ? ' on' : '') + '" data-act="rate" data-id="' + n + '" aria-label="' + n + ' glass' + (n > 1 ? 'es' : '') + '">' + glassSvg + '</button>';
    }).join('') + '<span class="pp-word">' + (WORDS[PP.draft.rating] || 'Select a rating') + '</span>';
  }
  function drawTags() {
    var w = findWine(PP.wineId), seen = {}, out = [];
    var add = function (tag, kind, count) {
      if (seen[tag]) return; seen[tag] = 1;
      var on = PP.draft.tags.indexOf(tag) >= 0;
      out.push('<button type="button" class="pp-tag' + (on ? ' on' : '') + (kind === 'oth' ? ' others' : '') + '" data-act="tag" data-id="' + esc(tag) + '" aria-pressed="' + on + '">' + esc(tag) + (count > 1 ? '<em>' + count + '</em>' : '') + '</button>');
    };
    (w.suggested_tags || []).forEach(function (t) { add(t, 'sug'); });
    (w.shared_tags || []).forEach(function (t) { add(t.tag, 'oth', t.count); });
    PP.draft.tags.forEach(function (t) { add(t, 'mine'); });
    $('pp-tagbox').innerHTML = out.join('');
  }
  function addTag() {
    var inp = $('pp-newtag'), t = normTag(inp.value);
    if (!t) { toast('Tags are 2–24 letters or numbers.'); return; }
    if (PP.draft.tags.indexOf(t) < 0) {
      if (PP.draft.tags.length >= 12) { toast('You can pick up to 12 tags.'); return; }
      PP.draft.tags.push(t);
    }
    inp.value = ''; drawTags();
  }
  function toggleTag(t) {
    var i = PP.draft.tags.indexOf(t);
    if (i >= 0) PP.draft.tags.splice(i, 1);
    else if (PP.draft.tags.length >= 12) { toast('You can pick up to 12 tags.'); return; }
    else PP.draft.tags.push(t);
    drawTags();
  }
  function closeWine() { $('pp-overlay').classList.remove('open'); document.body.style.overflow = ''; PP.wineId = null; }
  async function saveWine() {
    if (PP.saving) return;
    var w = findWine(PP.wineId); if (!w) return;
    PP.saving = true;
    var btn = $('pp-save'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      var body = { rating: PP.draft.rating || null, note: PP.draft.note, tags: PP.draft.tags, share_tags: PP.draft.share };
      var r = await apiFetch('PUT', '/passport/wines/' + encodeURIComponent(w.wine_id) + '/note', body);
      w.my = { rating: r.my.rating, note: r.my.note, tags: r.my.tags, share_tags: r.my.share_tags };
      closeWine(); rerender(); toast('Saved to your passport');
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Save to passport';
      toast(e.message || 'Could not save - please try again.');
    } finally { PP.saving = false; }
  }

  // ── Cover / lifecycle ─────────────────────────────────────────────────────
  async function loadPassport() {
    PP.loading = true; PP.loadError = '';
    try {
      PP.data = await apiFetch('GET', '/passport');
      // Stamps/summaries are generated in the background the first time; look again shortly.
      clearTimeout(PP.retry);
      if (PP.data.art_pending && PP.tries++ < 3) PP.retry = setTimeout(function () { if ($('view-passport').classList.contains('active')) loadPassport(); }, 7000);
    } catch (e) {
      PP.loadError = /not found|404/i.test(e.message) ? 'The passport isn’t available yet.' : 'Couldn’t load your passport: ' + e.message;
      if (e.status === 401) PP.loadError = 'Please sign in again.';
      banner(PP.loadError);
    } finally { PP.loading = false; }
    if ($('pp-app').classList.contains('show')) { if (!PP.loadError) banner(''); rerender(); }
  }
  function showCover() {
    PP.opening = false; PP.eventId = null; PP.tab = 'stamps'; PP.filter = 'all';
    $('pp-cover').style.display = 'flex'; $('pp-app').classList.remove('show');
    $('pp-book').classList.remove('opening');
    var nm = (member && (member.full_name || member.email)) || '';
    $('pp-cover-name').textContent = nm;
    $('pp-head-name').textContent = nm ? nm + '’s Passport' : 'Passport';
  }
  function openBook() {
    if (PP.opening) return; PP.opening = true;   // ignore double taps while the cover transitions
    $('pp-book').classList.add('opening');
    setTimeout(function () {
      $('pp-cover').style.display = 'none'; $('pp-app').classList.add('show');
      try { rerender(); } catch (e) { banner('Could not draw the passport: ' + e.message); }
      window.scrollTo(0, 0);
    }, 300);
  }
  window.openPassport = function () {
    setView('view-passport'); window.scrollTo(0, 0);
    showCover(); banner(''); PP.data = null; PP.tries = 0;
    loadPassport();
  };
  window.closePassport = function () { closeWine(); setView('view-home'); window.scrollTo(0, 0); };

  document.addEventListener('DOMContentLoaded', function () {
    var view = $('view-passport'); if (!view) return;
    $('pp-book').addEventListener('click', openBook);
    $('pp-open-btn').addEventListener('click', openBook);
    $('pp-book').addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBook(); } });
    view.addEventListener('click', function (e) {
      var el = e.target.closest('[data-act]'); if (!el) { if (e.target === $('pp-overlay')) closeWine(); return; }
      var act = el.getAttribute('data-act'), id = el.getAttribute('data-id');
      if (act === 'event') showEvent(id);
      else if (act === 'wine') openWine(id);
      else if (act === 'tab') setTab(id);
      else if (act === 'filter') { PP.filter = id; renderCellar(); }
      else if (act === 'rate') { var n = Number(id); PP.draft.rating = PP.draft.rating === n ? 0 : n; drawGlasses(); }
      else if (act === 'tag') toggleTag(id);
      else if (act === 'add-tag') addTag();
      else if (act === 'save-wine') saveWine();
      else if (act === 'close-wine') closeWine();
    });
    // A photo that fails to load falls back to the drawn bottle.
    view.addEventListener('error', function (e) {
      var img = e.target; if (!img || img.tagName !== 'IMG' || !img.getAttribute('data-wine')) return;
      var w = findWine(img.getAttribute('data-wine')); if (!w) return;
      var tmp = document.createElement('div'); tmp.innerHTML = bottleSvg(w);
      img.replaceWith(tmp.firstChild);
    }, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && $('pp-overlay').classList.contains('open')) closeWine(); });
  });
})();
