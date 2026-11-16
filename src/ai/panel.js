/**
 * Right-Sidebar AI Copilot UI Panel (Inspector → AI Copilot tab).
 * Renders live Groq model picker, hybrid key setup, active Guide checklist card,
 * Markdown chat stream, starter chips, and 3-way Auto | Build | Guide composer.
 */
import { getDef } from '../parts/registry.js';

const esc = (s) => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function formatMarkdown(md) {
  const escaped = esc(md || '');
  const blocks = [];
  // Extract fenced code blocks before inline formatting
  let work = escaped.replace(/```(?:\w+)?\n([\s\S]*?)```/g, (_, code) => {
    const idx = blocks.length;
    blocks.push(`<pre class="ai-pre"><code>${code.trimEnd()}</code></pre>`);
    return `@@BLOCK${idx}@@`;
  });

  const lines = work.split('\n');
  const out = [];
  let inList = false;

  for (const line of lines) {
    if (/^@@BLOCK\d+@@$/.test(line.trim())) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(line.trim());
      continue;
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line) || /^\s*\d+\.\s+(.*)$/.exec(line);
    if (bullet) {
      if (!inList) { out.push('<ul class="ai-ul">'); inList = true; }
      out.push(`<li>${inlineFmt(bullet[1])}</li>`);
      continue;
    }
    if (inList) { out.push('</ul>'); inList = false; }

    const head = /^(#{1,3})\s+(.*)$/.exec(line);
    if (head) {
      out.push(`<div class="ai-h">${inlineFmt(head[2])}</div>`);
    } else if (!line.trim()) {
      out.push('<div class="ai-gap"></div>');
    } else {
      out.push(`<p>${inlineFmt(line)}</p>`);
    }
  }
  if (inList) out.push('</ul>');

  return out.join('').replace(/@@BLOCK(\d+)@@/g, (_, i) => blocks[+i] || '');
}

function inlineFmt(s) {
  return s
    .replace(/`([^`]+)`/g, '<code class="ai-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\s][^*]*?)\*/g, '<em>$1</em>');
}

const STARTER_PROMPTS = [
  { label: '555 LED Blinker + Scope', mode: 'build', prompt: 'Build a 555 astable LED blinker (~2 Hz) and hook CH1 of the oscilloscope to its output.' },
  { label: 'Guide Me: 7408 AND Gate', mode: 'guide', prompt: 'Guide me step-by-step to build a 7408 AND gate with two switches and an LED.' },
  { label: 'Check Board & What Next?', mode: 'auto', prompt: 'Inspect my current board (even if incomplete): tell me what I seem to be building, any bugs or missing wires, and what to do next.' },
  { label: 'Read Instruments & Math', mode: 'auto', prompt: 'Read my oscilloscope, power supply, and signal generator values and verify the calculations.' },
];

export function mountAiPanel(ui, container) {
  const app = ui.app;
  const ai = app.ai;
  let keyDrawerOpen = false;
  let errorMsg = '';

  container.innerHTML = `
    <div class="ai-head">
      <select class="input small ai-model-sel" id="ai-model-sel" title="Groq model"></select>
      <button class="icon-btn small ai-key-btn" id="ai-key-btn" title="Groq API key">
        <span class="ai-key-dot" id="ai-key-dot"></span>🔑
      </button>
      <button class="text-btn small" id="ai-clear-btn" title="Clear chat">Clear</button>
    </div>
    <div class="ai-key-box" id="ai-key-box" hidden>
      <div class="ai-key-title">Groq API Key <a href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer">Get free key ↗</a></div>
      <div class="ai-key-row">
        <input type="password" class="input small" id="ai-key-input" placeholder="gsk_..." autocomplete="off" spellcheck="false">
        <button class="btn primary small" id="ai-key-save">Save</button>
      </div>
      <div class="ai-key-hint" id="ai-key-hint">Stored locally in your browser. Not needed if server key is enabled.</div>
    </div>
    <div class="ai-guide-card" id="ai-guide-card" hidden></div>
    <div class="ai-chat" id="ai-chat"></div>
    <div class="ai-composer">
      <div class="ai-mode-pill" id="ai-mode-pill" role="tablist">
        <button data-mode="auto">Auto</button>
        <button data-mode="build">Build</button>
        <button data-mode="guide">Guide</button>
      </div>
      <div class="ai-input-wrap">
        <textarea id="ai-input" class="ai-input" rows="2" placeholder="Ask, calculate, build, or say 'guide me'…"></textarea>
        <button id="ai-send" class="btn primary small ai-send-btn" title="Send (Enter)">Send</button>
      </div>
    </div>
  `;

  const modelSel = container.querySelector('#ai-model-sel');
  const keyBtn = container.querySelector('#ai-key-btn');
  const keyDot = container.querySelector('#ai-key-dot');
  const keyBox = container.querySelector('#ai-key-box');
  const keyInp = container.querySelector('#ai-key-input');
  const keySave = container.querySelector('#ai-key-save');
  const keyHint = container.querySelector('#ai-key-hint');
  const clearBtn = container.querySelector('#ai-clear-btn');
  const guideCard = container.querySelector('#ai-guide-card');
  const chatEl = container.querySelector('#ai-chat');
  const modePill = container.querySelector('#ai-mode-pill');
  const inputEl = container.querySelector('#ai-input');
  const sendBtn = container.querySelector('#ai-send');

  const placeholders = {
    auto: "Ask, calculate, build, or say 'guide me'…",
    build: 'Describe a circuit to auto-build & wire…',
    guide: 'Describe what to guide you to build step-by-step…',
  };

  const renderModels = () => {
    const cur = ai.model;
    modelSel.innerHTML = '';
    for (const m of ai.models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.id;
      if (m.id === cur) opt.selected = true;
      modelSel.append(opt);
    }
    if (cur && ![...modelSel.options].some(o => o.value === cur)) {
      const opt = document.createElement('option');
      opt.value = cur;
      opt.textContent = cur;
      opt.selected = true;
      modelSel.prepend(opt);
    }
  };

  const renderGuide = () => {
    const g = app.aiGuide.getState();
    if (!g) {
      guideCard.hidden = true;
      guideCard.innerHTML = '';
      return;
    }
    guideCard.hidden = false;
    const pct = g.total ? Math.round((g.doneCount / g.total) * 100) : 0;
    const act = g.activeStep;
    const rowsHtml = g.steps.map((s, idx) => {
      const cls = s.done ? 'done' : (act && act.id === s.id ? 'active' : '');
      const mark = s.done ? '✓' : (idx + 1);
      return `<div class="ai-gstep ${cls}"><span class="ai-gnum">${mark}</span><span class="ai-gtxt">${esc(s.desc)}</span></div>`;
    }).join('');

    guideCard.innerHTML = `
      <div class="ai-ghead">
        <b>${esc(g.title)}</b>
        <span class="ai-gstat">${g.doneCount}/${g.total}</span>
        <button class="icon-btn small" id="ai-gclose" title="End Guide">✕</button>
      </div>
      <div class="ai-gprog"><i style="width:${pct}%"></i></div>
      ${act ? `
        <div class="ai-gfocus">
          <div class="ai-gfocus-lbl">NEXT STEP</div>
          <div class="ai-gfocus-txt">${esc(act.desc)}</div>
          ${act.partialHint ? `<div class="ai-ghint">${esc(act.partialHint)}</div>` : ''}
          <div class="ai-gbtns">
            <button class="btn primary small" id="ai-gdo">Do Step For Me</button>
            <button class="btn small" id="ai-gall">Complete All</button>
          </div>
        </div>
      ` : `<div class="ai-gdone">All ${g.total} steps completed! Press <b>Simulate (⌘↵)</b> to run.</div>`}
      <div class="ai-glist">${rowsHtml}</div>
    `;

    guideCard.querySelector('#ai-gclose')?.addEventListener('click', () => app.aiGuide.stop());
    guideCard.querySelector('#ai-gdo')?.addEventListener('click', () => app.aiGuide.doCurrentStep());
    guideCard.querySelector('#ai-gall')?.addEventListener('click', () => app.aiGuide.doAllSteps());
  };

  const renderChat = () => {
    chatEl.innerHTML = '';
    if (!ai.messages.length && !ai.busy && !errorMsg) {
      const welcome = document.createElement('div');
      welcome.className = 'ai-empty';
      welcome.innerHTML = `
        <div class="ai-empty-title">CircuitForge AI Copilot</div>
        <div class="ai-empty-sub">Circuit-aware engineering tutor: build breadboards, check shorts, read oscilloscopes &amp; guide wiring step-by-step.</div>
        <div class="ai-chips"></div>
      `;
      const chips = welcome.querySelector('.ai-chips');
      for (const sp of STARTER_PROMPTS) {
        const b = document.createElement('button');
        b.className = 'ai-chip';
        b.innerHTML = `<span class="ai-chip-tag">${esc(sp.mode)}</span>${esc(sp.label)}`;
        b.addEventListener('click', () => submitPrompt(sp.prompt, sp.mode));
        chips.append(b);
      }
      chatEl.append(welcome);
      return;
    }

    for (const m of ai.messages) {
      const card = document.createElement('div');
      card.className = `ai-msg ${m.role}`;
      if (m.role === 'user') {
        card.innerHTML = `<div class="ai-bubble">${esc(m.text)}</div>`;
      } else {
        const b = m.meta?.build;
        const g = m.meta?.guide;
        const insts = app.circuit.parts.filter(p => getDef(p.type).cat === 'Instruments');
        let actionHtml = '';
        if (b?.ok) {
          const ops = [];
          if (b.partsAdded) ops.push(`+${b.partsAdded} part${b.partsAdded === 1 ? '' : 's'}`);
          if (b.wiresAdded) ops.push(`+${b.wiresAdded} wire${b.wiresAdded === 1 ? '' : 's'}`);
          if (b.wiresRemoved) ops.push(`−${b.wiresRemoved} wire${b.wiresRemoved === 1 ? '' : 's'}`);
          if (b.updatedCount) ops.push(`${b.updatedCount} updated`);
          const summaryTxt = ops.length ? ops.join(', ') : 'circuit verified';
          actionHtml = `<div class="ai-action ok">✓ Applied (${summaryTxt})${m.meta.selfFixed ? ' · auto-verified' : ''}.</div>`;
        } else if (b && !b.ok) {
          actionHtml = `<div class="ai-action err">⚠ Build check failed: ${esc((b.errors || []).join('; '))}</div>`;
        } else if (g?.ok) {
          actionHtml = `<div class="ai-action ok">✦ Guided build started (${g.stepCount} steps) — watch the highlighted canvas targets!</div>`;
        } else if (g && !g.ok) {
          actionHtml = `<div class="ai-action err">⚠ Guide check failed: ${esc((g.errors || []).join('; '))}</div>`;
        }

        const warnHtml = (b?.warnings?.length)
          ? `<div class="ai-action warn">${esc(b.warnings.slice(0, 2).join(' · '))}</div>`
          : '';

        const metaModel = m.meta?.modelUsed
          ? `<div class="ai-meta"><span>${esc(m.meta.modelUsed)}</span>${m.meta.switchedFrom ? ` · switched from ${esc(m.meta.switchedFrom)}` : ''}</div>`
          : '';

        card.innerHTML = `
          <div class="ai-md">${formatMarkdown(m.text)}</div>
          ${actionHtml}${warnHtml}${metaModel}
        `;
        if (b?.ok && insts.length) {
          const bar = document.createElement('div');
          bar.className = 'ai-inst-btns';
          for (const inst of insts) {
            const btn = document.createElement('button');
            btn.className = 'btn small';
            btn.textContent = `Open ${getDef(inst.type).short || getDef(inst.type).name} ↗`;
            btn.addEventListener('click', () => ui.openInstrumentWindow(inst));
            bar.append(btn);
          }
          card.append(bar);
        }
      }
      chatEl.append(card);
    }

    if (ai.busy) {
      const spin = document.createElement('div');
      spin.className = 'ai-msg assistant thinking';
      spin.innerHTML = '<div class="ai-dots"><i></i><i></i><i></i><span>Analyzing &amp; verifying…</span></div>';
      chatEl.append(spin);
    }
    if (errorMsg) {
      const err = document.createElement('div');
      err.className = 'ai-action err';
      err.textContent = errorMsg;
      chatEl.append(err);
    }
    chatEl.scrollTop = chatEl.scrollHeight;
  };

  const sync = () => {
    renderModels();
    const okAuth = ai.hasAuth;
    keyDot.className = 'ai-key-dot ' + (okAuth ? 'on' : 'off');
    keyInp.value = ai.apiKey;
    keyBox.hidden = !keyDrawerOpen && okAuth;
    keyHint.textContent = ai.apiKey
      ? 'Using your personal Groq key saved in localStorage.'
      : ai.hasServerKey
        ? 'Connected via server Groq proxy (or paste personal key above).'
        : 'Paste a free Groq API key (gsk_...) from console.groq.com/keys.';

    const curMode = ai.mode;
    for (const btn of modePill.querySelectorAll('button')) {
      btn.classList.toggle('on', btn.dataset.mode === curMode);
    }
    inputEl.placeholder = placeholders[curMode] || placeholders.auto;
    inputEl.disabled = ai.busy;
    sendBtn.disabled = ai.busy;
    sendBtn.textContent = ai.busy ? '…' : 'Send';

    renderGuide();
    renderChat();
  };

  const submitPrompt = async (customText = null, modeOverride = null) => {
    const txt = (customText !== null ? customText : inputEl.value).trim();
    if (!txt || ai.busy) return;
    if (customText === null) inputEl.value = '';
    if (modeOverride && modeOverride !== ai.mode) app.settings.set('aiMode', modeOverride);
    errorMsg = '';
    sync();
    try {
      await ai.ask(txt, modeOverride);
    } catch (err) {
      errorMsg = err?.message || 'Groq request failed.';
      if (!ai.hasAuth) keyDrawerOpen = true;
    }
    sync();
  };

  modelSel.addEventListener('change', (e) => {
    app.settings.set('aiModel', e.target.value);
    sync();
  });
  keyBtn.addEventListener('click', () => {
    keyDrawerOpen = !keyDrawerOpen;
    keyBox.hidden = !keyDrawerOpen && ai.hasAuth;
    if (!keyBox.hidden) keyInp.focus();
  });
  keySave.addEventListener('click', async () => {
    const v = keyInp.value.trim();
    app.settings.set('groqKey', v);
    errorMsg = '';
    await ai.refreshModels();
    keyDrawerOpen = false;
    ui.toast(v ? 'Groq API key saved & models refreshed.' : 'Personal Groq API key cleared.');
    sync();
  });
  clearBtn.addEventListener('click', () => {
    ai.clearChat();
    errorMsg = '';
    sync();
  });
  for (const btn of modePill.querySelectorAll('button')) {
    btn.addEventListener('click', () => {
      app.settings.set('aiMode', btn.dataset.mode);
      sync();
    });
  }
  sendBtn.addEventListener('click', () => submitPrompt());
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitPrompt();
    }
  });

  app.aiGuide.subscribe(() => renderGuide());
  sync();
  return { sync, focusInput: () => inputEl.focus() };
}
