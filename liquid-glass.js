/* ============================================================
   liquid-glass.js — Apple-style liquid glass for any plain HTML element (no React, no build step)
   idea and layer structure from rdev/liquid-glass-react (MIT, https://github.com/rdev/liquid-glass-react);
   the refraction is rebuilt so the rim really bends the background and splits it into colour.

   how it works:
     1. a "warp" layer, a little larger than the element, reads what is behind it with backdrop-filter (blur + saturate);
     2. an SVG filter on that layer runs feDisplacementMap with a lens map made for the element's exact size and corners:
        zero in the middle, growing toward the rim, pointing outward — so the rim pulls in and squeezes the scenery
        just outside the glass, which reads as the background liquefying around the edge;
     3. the displacement is done three times, red bending least and blue most, like light through a prism,
        so every edge in the background splits into coloured fringes at the rim;
     4. the warp layer is then clipped back to the element's rounded shape (filter runs before clip-path);
     5. a white specular rim and a soft spectral rim sit on top; their light follows the pointer;
     6. the element leans and stretches a little toward the pointer, and dips when pressed.

   usage:
     <script src="liquid-glass.js"></script>
     <button data-liquid-glass='{"radius": 999}'>…</button>          // picked up automatically
     const g = LiquidGlass.attach(el, { radius: 24 });  g.set({ refraction: 1.2 });  g.destroy();
   ============================================================ */
(function (global) {
  'use strict';

  const DEFAULTS = {
    radius: 999,          // corner radius in px (999 = pill)
    bezel: 0,             // width of the bending rim in px; 0 = automatic (about a third of the short side, max 34)
    refraction: 1,        // how far the rim bends the background (1 = it reaches roughly one rim-width outside)
    dispersion: 0.8,      // colour splitting at the rim (0 = none, 1 = strong prism)
    blur: 3,              // frosted blur, px
    saturation: 150,      // % saturation of what shows through
    prism: 0.85,          // strength of the soft spectral light along the rim (0 = off)
    specular: 1,          // strength of the white highlight along the rim (0 = off)
    elasticity: 0.15,     // how much it leans / stretches toward the pointer (0 = rigid)
    overLight: false,     // true on light backgrounds: darker tint and deeper shadow so the glass stays visible
    shadow: true,         // drop shadow under the glass
    activationZone: 200,  // px from the element's edge at which the pointer starts to pull it
  };

  const UA = navigator.userAgent;
  // an SVG filter over a backdrop only renders in Chromium; elsewhere it is plain frosted glass (no bending, no fringes)
  const CAN_REFRACT = !/firefox/i.test(UA) && /Chrome\/|Chromium\/|Edg\//.test(UA) && !/CriOS|FxiOS|EdgiOS/.test(UA);
  let uid = 0, styleInjected = false;

  // an animatable visibility var, so the glass can fade without opacity on the element itself
  // (opacity < 1, filter, mask or clip-path on the element or an ancestor cuts the backdrop off — the glass goes blank)
  try { CSS.registerProperty({ name: '--lg-vis', syntax: '<number>', inherits: true, initialValue: '1' }); } catch (e) {}

  function injectStyle() {
    if (styleInjected) return; styleInjected = true;
    const css = `
.lg-root { translate: var(--lg-tx, 0px) var(--lg-ty, 0px); scale: var(--lg-sx, 1) var(--lg-sy, 1);
  transition: translate .2s ease-out, scale .2s ease-out, --lg-vis .6s ease; }
.lg-root > .lg-layer { position: absolute; inset: 0; border-radius: inherit; pointer-events: none; transition: opacity .2s ease-out; }
.lg-root > .lg-svg { position: absolute; left: 0; top: 0; width: 0; height: 0; overflow: hidden; pointer-events: none; }
/* NOTE: no mix-blend-mode anywhere inside .lg-root — in Chrome a blending child isolates the root,
   and the backdrop-filter then sees nothing behind the element. */
.lg-root > .lg-shadow { opacity: var(--lg-vis); }
.lg-root > .lg-tint   { background: #000; opacity: calc(var(--lg-vis) * var(--lg-tint, 0)); }
.lg-root > .lg-warp   { inset: calc(var(--lg-m, 0px) * -1); border-radius: 0; opacity: var(--lg-vis); }
.lg-root > .lg-ring   { box-sizing: border-box;
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude; }
.lg-root > .lg-spec   { padding: 1.5px; opacity: calc(var(--lg-vis) * var(--lg-spec, 1));
  box-shadow: 0 0 0 .5px rgba(255,255,255,.45) inset, 0 1px 3px rgba(255,255,255,.3) inset; }
.lg-root > .lg-prism  { padding: 3.5px; filter: blur(.7px); opacity: calc(var(--lg-vis) * var(--lg-prism, .5)); }
.lg-root > .lg-hl     { opacity: 0; background-image: radial-gradient(circle at 50% 0%, rgba(255,255,255,.9) 0%, rgba(255,255,255,0) 75%); }
.lg-root.lg-hover > .lg-hl  { opacity: calc(var(--lg-vis) * .12); }
.lg-root.lg-active > .lg-hl { opacity: calc(var(--lg-vis) * .28); }
.lg-root.lg-active { scale: .96 .96; }
.lg-root > .lg-content { position: relative; z-index: 1; opacity: var(--lg-vis); }
`;
    const s = document.createElement('style'); s.id = 'liquid-glass-style'; s.textContent = css;
    document.head.appendChild(s);
  }

  /* ---------- the lens map ----------
     a displacement image for a box of size (w + 2m) x (h + 2m) with the glass shape in the middle.
     R = horizontal offset, B (and G) = vertical offset, 128 = no offset, ±127 = ±maxD px.            */
  function lensMap(w, h, m, r, bezel, maxD) {
    const W = Math.round(w + 2 * m), H = Math.round(h + 2 * m);
    const hw = w / 2, hh = h / 2, rr = Math.min(r, hw, hh);
    const rn = Math.min(Math.max(rr, bezel + 2), hw, hh);      // rounder shape just for the normals, so they turn smoothly
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d'), img = ctx.createImageData(W, H), d = img.data;
    for (let py = 0, p = 0; py < H; py++) {
      const y = py + .5 - m - hh, ay = Math.abs(y);
      for (let px = 0; px < W; px++, p += 4) {
        const x = px + .5 - m - hw, ax = Math.abs(x);
        // signed distance to the rounded rect (negative inside)
        const qx = ax - hw + rr, qy = ay - hh + rr;
        const sd = Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - rr;
        let ox = 0, oy = 0;
        if (sd < 0) {
          const t = Math.min(1, -sd / bezel), k = (1 - t) * (1 - t) * (1 + t);   // smooth: full at the rim, flat by the inner edge of the bezel
          if (k > 0) {
            const nx0 = ax - hw + rn, ny0 = ay - hh + rn;
            let nx, ny;
            if (nx0 > 0 && ny0 > 0) { const l = Math.hypot(nx0, ny0); nx = nx0 / l; ny = ny0 / l; }
            else if (nx0 > ny0) { nx = 1; ny = 0; } else { nx = 0; ny = 1; }
            ox = Math.sign(x) * nx * k; oy = Math.sign(y) * ny * k;              // outward: the rim reaches out and pulls the outside in
          }
        }
        d[p] = 128 + ox * 127; d[p + 1] = d[p + 2] = 128 + oy * 127; d[p + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL();
  }

  /* ---------- the SVG filter: three displacements (R bends least, B most), recombined ---------- */
  function buildFilter(id, map, W, H, maxD, disp) {
    const s = maxD * 255 / 127;                                // feDisplacementMap: offset = scale * (C - .5)
    const k = disp * .45;
    const ch = (name, f, row) => `
    <feDisplacementMap in="SourceGraphic" in2="MAP" scale="${(s * f).toFixed(2)}" xChannelSelector="R" yChannelSelector="B" result="${name}0"/>
    <feColorMatrix in="${name}0" type="matrix" values="${row}" result="${name}"/>`;
    return `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" aria-hidden="true"><defs>
  <filter id="${id}" x="0" y="0" width="${W}" height="${H}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
    <feImage x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none" href="${map}" result="MAP"/>
    ${ch('R', 1 - k, '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0')}
    ${ch('G', 1, '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0')}
    ${ch('B', 1 + k, '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0')}
    <feComposite in="R" in2="G" operator="arithmetic" k2="1" k3="1" result="RG"/>
    <feComposite in="RG" in2="B" operator="arithmetic" k2="1" k3="1"/>
  </filter>
</defs></svg>`;
  }

  /* ---------- one glass element ---------- */
  class Glass {
    constructor(el, opts) {
      injectStyle();
      this.el = el; this.o = Object.assign({}, DEFAULTS, opts);
      this.id = 'lg-filter-' + (++uid);
      this.px = null; this.py = null; this.tx = 0; this.ty = 0;
      this._build();
      this._onMove = e => { this.px = e.clientX; this.py = e.clientY; this._queue(); };
      this._onUp = e => { if (e.pointerType !== 'mouse') { this.px = this.py = null; this._queue(); } this.el.classList.remove('lg-active'); };
      this._onDown = () => this.el.classList.add('lg-active');
      this._onEnter = () => this.el.classList.add('lg-hover');
      this._onLeave = () => this.el.classList.remove('lg-hover', 'lg-active');
      addEventListener('pointermove', this._onMove, { passive: true });
      addEventListener('pointerup', this._onUp); addEventListener('pointercancel', this._onUp);
      el.addEventListener('pointerdown', this._onDown);
      el.addEventListener('pointerenter', this._onEnter); el.addEventListener('pointerleave', this._onLeave);
      this.ro = new ResizeObserver(() => this._measure()); this.ro.observe(el);
      this._apply();
    }
    _build() {
      const el = this.el, cs = getComputedStyle(el);
      this._prev = { position: el.style.position, borderRadius: el.style.borderRadius };
      if (cs.position === 'static') el.style.position = 'relative';
      el.classList.add('lg-root');
      this.content = document.createElement('span'); this.content.className = 'lg-content';
      if (/flex|grid/.test(cs.display)) this.content.style.display = 'contents';
      while (el.firstChild) this.content.appendChild(el.firstChild);
      const L = cls => { const s = document.createElement('span'); s.className = 'lg-layer ' + cls; s.setAttribute('aria-hidden', 'true'); return s; };
      this.svgHost = document.createElement('span'); this.svgHost.className = 'lg-svg'; this.svgHost.setAttribute('aria-hidden', 'true');
      this.shadow = L('lg-shadow'); this.tint = L('lg-tint'); this.warp = L('lg-warp');
      this.prismL = L('lg-ring lg-prism'); this.spec = L('lg-ring lg-spec'); this.hl = L('lg-hl');
      this.layers = [this.svgHost, this.shadow, this.tint, this.warp, this.content, this.prismL, this.spec, this.hl];
      el.append(...this.layers);
    }
    _apply() {
      const o = this.o, el = this.el;
      el.style.borderRadius = o.radius + 'px';
      this.shadow.style.boxShadow = !o.shadow ? '' : o.overLight ? '0 16px 70px rgba(0,0,0,.6)' : '0 10px 34px rgba(0,0,0,.22)';
      el.style.setProperty('--lg-tint', o.overLight ? .25 : 0);
      el.style.setProperty('--lg-prism', o.prism);
      el.style.setProperty('--lg-spec', o.specular);
      const bd = `blur(${o.overLight ? o.blur + 8 : o.blur}px) saturate(${o.saturation}%)`;
      this.warp.style.backdropFilter = bd; this.warp.style.webkitBackdropFilter = bd;
      this._key = null; this._measure();
    }
    _measure() {
      const o = this.o, w = this.el.offsetWidth, h = this.el.offsetHeight;
      this.w = w; this.h = h;
      if (!w || !h) return;
      const r = Math.min(o.radius, w / 2, h / 2);
      const bezel = o.bezel || Math.max(8, Math.min(34, Math.min(w, h) * .36));
      const maxD = bezel * .9 * o.refraction;
      // the warp layer reaches m px past the element so the rim has real scenery to pull in; then it is clipped back
      const m = CAN_REFRACT ? Math.ceil(maxD * (1 + o.dispersion * .45) + 2) : 0;
      this.el.style.setProperty('--lg-m', m + 'px');
      this.warp.style.clipPath = `inset(${m}px round ${r}px)`;
      if (CAN_REFRACT && maxD > 0) {
        const key = [w, h, r, bezel, maxD, o.dispersion].join();
        if (key !== this._key) {
          this._key = key;
          const W = Math.round(w + 2 * m), H = Math.round(h + 2 * m);
          this.svgHost.innerHTML = buildFilter(this.id, lensMap(w, h, m, r, bezel, maxD), W, H, maxD, o.dispersion);
          this.warp.style.filter = `url(#${this.id})`;
        }
      } else { this.warp.style.filter = ''; this.svgHost.innerHTML = ''; this._key = null; }
      this._queue();
    }
    _queue() { if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; this._update(); }); }
    _update() {
      const o = this.o, el = this.el, rc = el.getBoundingClientRect();
      const cx = rc.left + rc.width / 2 - this.tx, cy = rc.top + rc.height / 2 - this.ty;
      let tx = 0, ty = 0, sx = 1, sy = 1, ox = 0, oy = 0;
      if (this.px !== null) {
        const dx = this.px - cx, dy = this.py - cy;
        ox = dx / this.w * 100; oy = dy / this.h * 100;
        const ex = Math.max(0, Math.abs(dx) - this.w / 2), ey = Math.max(0, Math.abs(dy) - this.h / 2);
        const fade = Math.max(0, 1 - Math.hypot(ex, ey) / o.activationZone);
        if (fade > 0) {
          tx = dx * o.elasticity * .1 * fade; ty = dy * o.elasticity * .1 * fade;
          const dd = Math.hypot(dx, dy);
          if (dd > 0) {
            const nx = Math.abs(dx / dd), ny = Math.abs(dy / dd), k = Math.min(dd / 300, 1) * o.elasticity * fade;
            sx = Math.max(.8, 1 + nx * k * .3 - ny * k * .15);
            sy = Math.max(.8, 1 + ny * k * .3 - nx * k * .15);
          }
        }
      }
      this.tx = tx; this.ty = ty;
      el.style.setProperty('--lg-tx', tx.toFixed(2) + 'px'); el.style.setProperty('--lg-ty', ty.toFixed(2) + 'px');
      el.style.setProperty('--lg-sx', sx.toFixed(4)); el.style.setProperty('--lg-sy', sy.toFixed(4));
      // light comes from the top-left by default and swings with the pointer
      const a = 135 + ox * 1.2, b1 = Math.max(10, 33 + oy * .3), b2 = Math.min(90, 66 + oy * .4);
      this.spec.style.background = `linear-gradient(${a}deg, rgba(255,255,255,0) 0%, rgba(255,255,255,${.35 + Math.abs(ox) * .006}) ${b1}%, rgba(255,255,255,${.75 + Math.abs(ox) * .006}) ${b2}%, rgba(255,255,255,0) 100%)`;
      // two spectral arcs on opposite sides of the rim, like light split by the glass edge
      // wide and soft, centred on the lit corner (top-left by default) and the opposite one
      const band = 'rgba(255,100,130,0) 0deg, rgba(255,110,140,.55) 16deg, rgba(255,200,110,.75) 34deg, rgba(150,255,170,.7) 50deg, rgba(100,200,255,.75) 66deg, rgba(175,130,255,.55) 84deg, rgba(175,130,255,0) 100deg';
      this.prismL.style.background = `conic-gradient(from ${a + 130}deg, ${band}, transparent 100deg 180deg, ${band.replace(/(\d+)deg/g, (_, n) => (+n + 180) + 'deg')}, transparent 280deg)`;
    }
    /** change options at runtime, e.g. g.set({ refraction: 1.4, dispersion: .8 }) */
    set(opts) { Object.assign(this.o, opts); this._apply(); return this; }
    /** remove the effect and put the element back as it was */
    destroy() {
      removeEventListener('pointermove', this._onMove); removeEventListener('pointerup', this._onUp); removeEventListener('pointercancel', this._onUp);
      const el = this.el;
      el.removeEventListener('pointerdown', this._onDown); el.removeEventListener('pointerenter', this._onEnter); el.removeEventListener('pointerleave', this._onLeave);
      this.ro.disconnect(); cancelAnimationFrame(this._raf);
      while (this.content.firstChild) el.insertBefore(this.content.firstChild, this.content);
      this.layers.forEach(n => n.remove());
      el.classList.remove('lg-root', 'lg-hover', 'lg-active');
      ['--lg-tx', '--lg-ty', '--lg-sx', '--lg-sy', '--lg-tint', '--lg-prism', '--lg-spec', '--lg-m'].forEach(p => el.style.removeProperty(p));
      Object.assign(el.style, this._prev);
      delete el._liquidGlass;
    }
  }

  const LiquidGlass = {
    /** turn an element into liquid glass; returns a handle with .set(opts) and .destroy() */
    attach(el, opts = {}) {
      if (typeof el === 'string') el = document.querySelector(el);
      if (!el) throw new Error('LiquidGlass.attach: element not found');
      return el._liquidGlass || (el._liquidGlass = new Glass(el, opts));
    },
    /** attach to every element matching a selector (default [data-liquid-glass]); options can be JSON in the attribute */
    attachAll(selector = '[data-liquid-glass]', opts = {}) {
      return [...document.querySelectorAll(selector)].map(el => {
        let o = opts; const a = el.getAttribute('data-liquid-glass');
        if (a) try { o = Object.assign({}, opts, JSON.parse(a)); } catch (e) {}
        return LiquidGlass.attach(el, o);
      });
    },
    /** false on Firefox / Safari / iOS: they get frosted glass without bending and colour fringes */
    canRefract: CAN_REFRACT,
    defaults: DEFAULTS,
  };
  global.LiquidGlass = LiquidGlass;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => LiquidGlass.attachAll());
  else LiquidGlass.attachAll();
})(window);
