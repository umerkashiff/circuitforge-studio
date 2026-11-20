/**
 * CircuitForge Studio — Optimized Native Landing Controller
 * Zero framework overhead:
 *  - Exact Relay WebGL2 WarpText liquid-refraction + pointer-ripple hero shader
 *  - 36-beam counter-wave cobalt pulse generator
 *  - Spring-matched scroll reveals & animated stat counters
 *  - Interactive Showcase 4-tab accordion synced to real captured simulator GIFs
 *  - Starter track filter, FAQ accordion, and mobile drawer
 */

(() => {
  'use strict';

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* 1. 36-Beam Counter-Wave Pulse Generator (Relay exact 3s left->right & right->left timing) */
  function populateBeams(container, count = 36) {
    if (!container) return;
    const row = document.createElement('div');
    row.className = 'beams-row';
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
      const col = document.createElement('div');
      col.className = 'beam-col';
      col.style.setProperty('--bd', ((i / count) * 3).toFixed(2) + 's');
      col.style.setProperty('--bd-rev', (((count - 1 - i) / count) * 3).toFixed(2) + 's');
      col.innerHTML =
        '<div class="beam-line"></div>' +
        '<div class="beam-streak-top"></div>' +
        '<div class="beam-streak-bot"></div>';
      frag.appendChild(col);
    }
    row.appendChild(frag);
    container.appendChild(row);
  }

  document.querySelectorAll('[data-beams]').forEach((el) => {
    populateBeams(el, parseInt(el.dataset.beams || '36', 10));
  });

  /* 2. Exact Relay WebGL2 WarpText Shader (Zero-Dependency Native GLSL ES 3.00) */
  function initWarpHeadline() {
    const host = document.getElementById('warp-host');
    if (!host || reducedMotion) return;

    const line1 = host.dataset.line1 || 'Wire real circuits';
    const line2 = host.dataset.line2 || 'in your browser.';

    const canvas = document.createElement('canvas');
    canvas.className = 'warp-canvas';
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: true });
    if (!gl) return;

    const vsSrc = `#version 300 es
      in vec2 aPos;
      out vec2 vUv;
      void main() {
        vUv = aPos * 0.5 + 0.5;
        gl_Position = vec4(aPos, 0.0, 1.0);
      }`;

    const fsSrc = `#version 300 es
      precision highp float;
      uniform sampler2D uTextTexture;
      uniform vec2 uResolution;
      uniform vec2 uPointer;
      uniform float uPointerActive;
      uniform float uTime;
      uniform float uWarpStrength;
      uniform float uWarpScale;
      uniform float uSpeed;
      uniform float uPointerInfluence;
      uniform float uPointerStrength;
      uniform float uRefraction;
      uniform float uRipple;
      uniform float uMotion;
      in vec2 vUv;
      out vec4 fragColor;

      float hash(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }
      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
          mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
          u.y
        );
      }
      float fbm(vec2 p) {
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 4; i++) {
          v += a * noise(p);
          p *= 2.02;
          a *= 0.5;
        }
        return v;
      }
      vec4 sampleText(vec2 uv) {
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
        return texture(uTextTexture, uv);
      }
      void main() {
        vec2 uv = vUv;
        float aspect = uResolution.x / max(uResolution.y, 1.0);
        float time = uTime * uSpeed;
        float scale = max(uWarpScale, 0.001);

        vec2 drift = vec2(time * 0.055, -time * 0.045);
        float n1 = fbm(uv * scale * 3.1 + drift);
        float n2 = fbm((uv + 19.17) * scale * 3.4 - drift.yx);
        vec2 ambient = (vec2(n1, n2) - 0.5) * uWarpStrength * 0.045 * uMotion;

        vec2 pointerDelta = uv - uPointer;
        vec2 aspectDelta = vec2(pointerDelta.x * aspect, pointerDelta.y);
        float dist = length(aspectDelta);
        float radius = max(uPointerInfluence, 0.001);
        float t = clamp(dist / radius, 0.0, 1.0);
        float lens = smoothstep(radius, 0.0, dist) * uPointerActive;
        float bulge = t * (1.0 - t) * (1.0 - t) * 6.75 * uPointerActive;
        vec2 dir = dist > 0.0001 ? vec2(aspectDelta.x / aspect, aspectDelta.y) / dist : vec2(0.0);

        float rippleWave = sin(dist * 28.0 - time * 4.2) * 0.5 + 0.5;
        float rippleRing = (rippleWave - 0.5) * uRipple;
        vec2 pointerWarp = -dir * bulge * uPointerStrength * 0.045;
        pointerWarp += dir * rippleRing * bulge * uPointerStrength * 0.016;

        vec2 displaced = uv + ambient + pointerWarp;
        vec2 splitDir = ambient + pointerWarp;
        float splitLen = length(splitDir);
        splitDir = splitLen > 0.00001 ? splitDir / splitLen : vec2(0.7071, 0.7071);
        vec2 split = splitDir * uRefraction * 0.16 * (0.35 + lens * 1.65);

        vec4 base = sampleText(displaced);
        float r = sampleText(displaced + split).r;
        float g = base.g;
        float b = sampleText(displaced - split).b;
        float a = max(max(sampleText(displaced + split).a, base.a), sampleText(displaced - split).a);

        // Subtle CircuitForge cobalt sheen under pointer lens
        vec3 tint = vec3(0.04, 0.52, 1.0) * lens * base.a * 0.08;
        vec3 color = vec3(r, g, b) + lens * base.a * 0.045 + tint;
        fragColor = vec4(color, a);
      }`;

    function compile(type, src) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return null;
      return sh;
    }

    const vs = compile(gl.VERTEX_SHADER, vsSrc);
    const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
    if (!vs || !fs) return;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    const loc = {
      uTextTexture: gl.getUniformLocation(prog, 'uTextTexture'),
      uResolution: gl.getUniformLocation(prog, 'uResolution'),
      uPointer: gl.getUniformLocation(prog, 'uPointer'),
      uPointerActive: gl.getUniformLocation(prog, 'uPointerActive'),
      uTime: gl.getUniformLocation(prog, 'uTime'),
      uWarpStrength: gl.getUniformLocation(prog, 'uWarpStrength'),
      uWarpScale: gl.getUniformLocation(prog, 'uWarpScale'),
      uSpeed: gl.getUniformLocation(prog, 'uSpeed'),
      uPointerInfluence: gl.getUniformLocation(prog, 'uPointerInfluence'),
      uPointerStrength: gl.getUniformLocation(prog, 'uPointerStrength'),
      uRefraction: gl.getUniformLocation(prog, 'uRefraction'),
      uRipple: gl.getUniformLocation(prog, 'uRipple'),
      uMotion: gl.getUniformLocation(prog, 'uMotion'),
    };

    const textCanvas = document.createElement('canvas');
    const tctx = textCanvas.getContext('2d');

    function measureTracked(ctx, text, spacing) {
      const chars = Array.from(text);
      return chars.reduce((acc, ch) => acc + ctx.measureText(ch).width, 0) + Math.max(0, chars.length - 1) * spacing;
    }

    function drawTracked(ctx, text, cx, y, spacing) {
      const chars = Array.from(text);
      let x = cx - measureTracked(ctx, text, spacing) / 2;
      chars.forEach((ch, idx) => {
        ctx.fillText(ch, x, y);
        x += ctx.measureText(ch).width + (idx === chars.length - 1 ? 0 : spacing);
      });
    }

    let cssW = 712;
    let cssH = 176;

    function rebuildTexture() {
      const w = Math.max(280, Math.floor(host.clientWidth || 712));
      const vw = window.innerWidth;
      let s1, s2, lh, ls;
      if (vw >= 1024) { s1 = 72; s2 = 64; lh = 84; ls = -1.4; }
      else if (vw >= 768) { s1 = 60; s2 = 48; lh = 72; ls = -1.2; }
      else if (vw >= 640) { s1 = 48; s2 = 44; lh = 58; ls = -1.0; }
      else {
        const k = Math.max(0, Math.min(1, (vw - 320) / 320));
        s1 = Math.round(32 + 16 * k);
        s2 = Math.round(28 + 14 * k);
        lh = Math.round(1.22 * s1);
        ls = -0.6;
      }

      const fontFam = '"Urbanist", "Geist", -apple-system, sans-serif';
      tctx.font = `500 ${s1}px ${fontFam}`;
      const w1 = measureTracked(tctx, line1, ls);
      const maxW = w * 0.94;
      if (w1 > maxW && maxW > 0) {
        const sc = maxW / w1;
        s1 = Math.floor(s1 * sc);
        s2 = Math.floor(s2 * sc);
        lh = Math.floor(lh * sc);
      }

      tctx.font = `600 ${s2}px ${fontFam}`;
      const w2 = measureTracked(tctx, line2, ls);

      const padY = Math.max(5, Math.round(0.08 * s2));
      const padX = Math.max(12, Math.round(0.2 * s2));
      const boxH = Math.round(1.12 * s2 + 2 * padY);
      const boxW = Math.round(w2 + 2 * padX);
      const y1 = 8 + Math.round(0.52 * s1);
      const y2 = y1 + lh;
      const totalH = Math.ceil(y2 + 0.55 * boxH + 10);

      cssW = w;
      cssH = totalH;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.height = cssH + 'px';

      textCanvas.width = canvas.width;
      textCanvas.height = canvas.height;
      tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      tctx.clearRect(0, 0, cssW, cssH);
      tctx.textBaseline = 'middle';
      tctx.textAlign = 'left';

      // Line 1
      tctx.fillStyle = '#f4f4f5';
      tctx.font = `500 ${s1}px ${fontFam}`;
      drawTracked(tctx, line1, cssW / 2, y1, ls);

      // Dashed rectangle around line 2 (Relay exact style, subtle #27272A dashed border)
      tctx.save();
      tctx.strokeStyle = '#27272A';
      tctx.lineWidth = 1.5;
      tctx.setLineDash([5, 4]);
      tctx.strokeRect(
        Math.round((cssW - boxW) / 2) + 0.5,
        Math.round(y2 - boxH / 2) + 0.5,
        boxW,
        boxH
      );
      tctx.restore();

      // Line 2
      tctx.fillStyle = '#fafafa';
      tctx.font = `600 ${s2}px ${fontFam}`;
      drawTracked(tctx, line2, cssW / 2, y2, ls);

      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, textCanvas);
      gl.viewport(0, 0, canvas.width, canvas.height);
    }

    host.appendChild(canvas);
    host.classList.add('gl-ready');
    rebuildTexture();
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(rebuildTexture);
    }

    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(rebuildTexture, 120);
    });

    const ptr = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5, active: 0.18, target: 0.18, hovering: false };
    host.addEventListener('pointerenter', () => { ptr.hovering = true; ptr.target = 1.0; });
    host.addEventListener('pointerleave', () => { ptr.hovering = false; ptr.target = 0.18; });
    host.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      ptr.tx = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      ptr.ty = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
      ptr.hovering = true;
      ptr.target = 1.0;
    }, { passive: true });

    let visible = true;
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entries) => {
        visible = entries[0]?.isIntersecting ?? true;
      }, { threshold: 0.02 }).observe(host);
    }

    const t0 = performance.now();
    function render(now) {
      requestAnimationFrame(render);
      if (!visible) return;
      const elapsed = (now - t0) * 0.001;
      if (!ptr.hovering) {
        ptr.tx = 0.5 + 0.12 * Math.sin(elapsed * 0.33);
        ptr.ty = 0.5 + 0.10 * Math.cos(elapsed * 0.27);
      }
      ptr.x += (ptr.tx - ptr.x) * 0.12;
      ptr.y += (ptr.ty - ptr.y) * 0.12;
      ptr.active += (ptr.target - ptr.active) * 0.12;

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(loc.uTextTexture, 0);
      gl.uniform2f(loc.uResolution, canvas.width, canvas.height);
      gl.uniform2f(loc.uPointer, ptr.x, ptr.y);
      gl.uniform1f(loc.uPointerActive, ptr.active);
      gl.uniform1f(loc.uTime, elapsed);
      gl.uniform1f(loc.uWarpStrength, 0.08);
      gl.uniform1f(loc.uWarpScale, 1.7);
      gl.uniform1f(loc.uSpeed, 0.55);
      gl.uniform1f(loc.uPointerInfluence, 0.42);
      gl.uniform1f(loc.uPointerStrength, 0.38);
      gl.uniform1f(loc.uRefraction, 0.018);
      gl.uniform1f(loc.uRipple, 1.0);
      gl.uniform1f(loc.uMotion, 1.0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    requestAnimationFrame(render);
  }
  initWarpHeadline();

  /* 3. Scroll-triggered Reveals */
  const reveals = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && !reducedMotion) {
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      }
    }, { threshold: 0.08, rootMargin: '0px 0px -24px 0px' });
    reveals.forEach((el) => io.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add('in'));
  }

  /* 4. Spring Number Counters (Relay useSpring stat counter effect) */
  const counters = document.querySelectorAll('[data-count]');
  if (counters.length && 'IntersectionObserver' in window && !reducedMotion) {
    const cio = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        const target = parseInt(el.dataset.count || '0', 10);
        const suffix = el.dataset.suffix || '';
        let val = 0;
        let vel = 0;
        const stiffness = 55;
        const damping = 16;
        let last = performance.now();
        function step(now) {
          const dt = Math.min((now - last) / 1000, 0.05);
          last = now;
          const acc = (target - val) * stiffness - vel * damping;
          vel += acc * dt;
          val += vel * dt;
          el.textContent = Math.round(val) + suffix;
          if (Math.abs(target - val) > 0.25 || Math.abs(vel) > 0.25) {
            requestAnimationFrame(step);
          } else {
            el.textContent = target + suffix;
          }
        }
        requestAnimationFrame(step);
        cio.unobserve(el);
      }
    }, { threshold: 0.35 });
    counters.forEach((c) => cio.observe(c));
  }

  /* 5. Mobile Navigation Drawer */
  const drawer = document.getElementById('mobile-drawer');
  const openBtn = document.getElementById('open-menu');
  const closeBtn = document.getElementById('close-menu');
  const setDrawer = (open) => {
    if (!drawer) return;
    drawer.classList.toggle('open', open);
    drawer.setAttribute('aria-hidden', String(!open));
    document.body.style.overflow = open ? 'hidden' : '';
  };
  openBtn?.addEventListener('click', () => setDrawer(true));
  closeBtn?.addEventListener('click', () => setDrawer(false));
  drawer?.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => setDrawer(false)));
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') setDrawer(false); });

  /* 6. Interactive Showcase Accordion + Real Simulator GIF Switcher (Relay two-state pattern) */
  const wbTabs = [...document.querySelectorAll('.wb-tab')];
  const wbMedia = [...document.querySelectorAll('.wb-media-item')];
  const wbLiveText = document.getElementById('wb-live-text');
  const wbOpenLink = document.getElementById('wb-open-link');
  let expandedIdx = 0;
  let mediaIdx = 0;

  function renderShowcase() {
    wbTabs.forEach((tab, i) => {
      const isOpen = i === expandedIdx;
      const isSelected = i === mediaIdx;
      tab.classList.toggle('open', isOpen);
      tab.classList.toggle('selected', isSelected);
      tab.querySelector('.wb-tab-btn')?.setAttribute('aria-expanded', String(isOpen));
    });
    wbMedia.forEach((media, i) => {
      const isActive = i === mediaIdx;
      media.classList.toggle('active', isActive);
      if (media.tagName === 'VIDEO') {
        if (isActive) {
          media.currentTime = 0;
          media.play().catch(() => {});
        } else {
          media.pause();
        }
      }
    });
    const activeTab = wbTabs[mediaIdx];
    if (activeTab && wbLiveText) wbLiveText.textContent = activeTab.dataset.caption || '';
    if (activeTab && wbOpenLink) {
      wbOpenLink.href = activeTab.dataset.href || '/studio';
    }
  }

  wbTabs.forEach((tab, idx) => {
    tab.querySelector('.wb-tab-btn')?.addEventListener('click', () => {
      mediaIdx = idx;
      expandedIdx = expandedIdx === idx ? -1 : idx;
      renderShowcase();
    });
  });
  renderShowcase();

  /* 7. Starter Circuits Track Filter */
  const filterBtns = document.querySelectorAll('[data-track-filter]');
  const tierCards = document.querySelectorAll('.tier-card[data-track]');
  filterBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.trackFilter;
      filterBtns.forEach((b) => b.classList.toggle('active', b === btn));
      tierCards.forEach((card) => {
        const match = mode === 'all' || card.dataset.track === mode;
        card.style.opacity = match ? '1' : '0.35';
      });
    });
  });

  /* 8. FAQ Single-Open Accordion (closed by default like Relay) */
  const faqItems = [...document.querySelectorAll('.faq-item')];
  faqItems.forEach((item) => {
    item.querySelector('.faq-q')?.addEventListener('click', () => {
      const wasOpen = item.classList.contains('open');
      faqItems.forEach((it) => {
        it.classList.remove('open');
        it.querySelector('.faq-q')?.setAttribute('aria-expanded', 'false');
      });
      if (!wasOpen) {
        item.classList.add('open');
        item.querySelector('.faq-q')?.setAttribute('aria-expanded', 'true');
      }
    });
  });
})();
