/* Qari v15 features: library, sentence options, learning mode, word list & flashcards,
   bookmarks & highlights, sleep timer, recap, offline downloads, book finder,
   scan clean-up and Arabic vowel marks. Uses globals from index.html. */
(function () {
  'use strict';

  // ---------------- small helpers ----------------
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid.nodeType ? kid : String(kid));
    return n;
  }
  // Like node.append, but skips null/false (used for optional pieces).
  const put = (node, ...kids) => node.append(...kids.flat().filter(k => k !== null && k !== undefined && k !== false));
  const pref = (k, d) => storedVoice('x.' + k) || d;
  const setPref = (k, v) => saveVoiceSetting('x.' + k, String(v));
  const dirOf = lang => lang === 'ar' ? 'rtl' : 'ltr';
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const chapterKey = s => s ? (s.label || ('p' + s.pageNum)) : null;
  const bookTitle = () => ($('bookTitle').textContent || 'Book');
  const placeLabel = s => s ? (s.label || ((bookIsArabic ? 'صفحة ' : 'Page ') + s.pageNum)) : '';
  const LANG_OPTS = [['ar', 'العربية'], ['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch']];
  const sleepMs = ms => new Promise(r => setTimeout(r, ms));

  function sheet(title, sub) {
    document.querySelectorAll('dialog.sheet[open]').forEach(d => d.close());
    const d = el('dialog', {class: 'sheet'});
    d.append(el('button', {class: 'x', 'aria-label': 'Close', onclick: () => d.close()}, '✕'), el('h2', {}, title));
    if (sub) d.append(el('p', {class: 'sub'}, sub));
    const body = el('div');
    d.append(body);
    d.addEventListener('click', e => {
      if (e.target !== d) return;
      const r = d.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
    });
    d.addEventListener('close', () => { try { d.onClosed?.(); } finally { d.remove(); } });
    document.body.append(d);
    d.showModal();
    return {d, body};
  }
  const button = (label, onclick, primary) => el('button', {class: 'btn' + (primary ? ' primary' : ''), onclick}, label);
  function needBook() { if (sentences.length && activeBook) return true; toast(bookIsArabic ? 'افتحي كتاباً أولاً' : 'Open a book first'); return false; }

  // ---------------- one-off speech (repeat, words, recap) ----------------
  let oneShot = null, oneShotUrl = null;
  function stopOneShot() { if (oneShot) { oneShot.pause(); oneShot = null; } if (oneShotUrl) { URL.revokeObjectURL(oneShotUrl); oneShotUrl = null; } if (synth) synth.cancel(); }
  function bestVoice(lang) {
    return voices.filter(v => v.lang.toLowerCase().startsWith(lang)).sort((a, b) => voiceQuality(b) - voiceQuality(a))[0];
  }
  function deviceSpeak(text, rate, lang) {
    if (!synth) { toast('Device voice is not available in this browser.'); return; }
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    lang = lang || bookLang;
    const sel = $('voiceSel').value, v = voices[parseInt(sel)];
    if (lang === bookLang && sel !== 'auto' && v) { u.voice = v; u.lang = v.lang; }
    else { const b = bestVoice(lang); if (b) { u.voice = b; u.lang = b.lang; } else u.lang = LANG_CODES[lang] || 'en-US'; }
    u.rate = rate || 1;
    synth.speak(u);
  }
  async function say(text, rate = 1, lang = bookLang, statusEl) {
    if (playing) stopSpeech();
    stopOneShot();
    if (isNatural() && geminiVoiceKey && navigator.onLine !== false) {
      try {
        if (statusEl) statusEl.textContent = '…';
        const blob = await naturalEngine.generate(text, geminiVoiceKey, $('narratorSel').value, LANG_NAMES[lang] || 'English');
        oneShotUrl = URL.createObjectURL(blob);
        oneShot = new Audio(oneShotUrl);
        oneShot.playbackRate = rate;
        await oneShot.play();
        if (statusEl) statusEl.textContent = '';
        return;
      } catch (e) { if (statusEl) statusEl.textContent = ''; }
    }
    deviceSpeak(text, rate, lang);
  }

  // ---------------- bookmarks & highlights ----------------
  let notes = [];
  function anchorOf(i) {
    const s = sentences[i];
    const first = sentences.findIndex(x => x.pageState === s.pageState);
    return {pageNum: s.pageNum, offset: i - first, snippet: s.text.slice(0, 80)};
  }
  function resolveNote(n) {
    const first = sentences.findIndex(s => s.pageNum === n.pageNum);
    if (first < 0) return -1;
    const i = first + n.offset;
    if (sentences[i]?.pageNum === n.pageNum && sentences[i].text.slice(0, 80) === n.snippet) return i;
    const key = QariAI.stripMarks(n.snippet).slice(0, 30);
    const j = sentences.findIndex(s => s.pageNum === n.pageNum && QariAI.stripMarks(s.text).startsWith(key));
    if (j >= 0) return j;
    return sentences[i]?.pageNum === n.pageNum ? i : first;
  }
  let applyTimer = null;
  function applyNotes() {
    clearTimeout(applyTimer);
    applyTimer = setTimeout(() => {
      sentences.forEach(s => s.el.classList.remove('hl', 'mark'));
      for (const n of notes) { const i = resolveNote(n); if (i >= 0) sentences[i].el.classList.add(n.type === 'highlight' ? 'hl' : 'mark'); }
    }, 60);
  }
  async function loadNotes() {
    notes = activeBook ? await bookStorage.notes(activeBook.id).catch(() => []) : [];
    applyNotes();
  }
  async function addNote(type, i) {
    if (!needBook() || !sentences[i]) return;
    const note = {id: uid(), bookId: activeBook.id, type, ...anchorOf(i), text: sentences[i].text, where: placeLabel(sentences[i]), created: Date.now()};
    ensureBookSaved(activeBook);
    notes.push(note);
    await bookStorage.saveNote(note).catch(() => toast('Could not save on this device.'));
    applyNotes();
  }
  async function removeNote(note) {
    notes = notes.filter(n => n.id !== note.id);
    await bookStorage.deleteNote(note.id).catch(() => {});
    applyNotes();
  }
  const highlightAt = i => notes.find(n => n.type === 'highlight' && resolveNote(n) === i);
  async function toggleHighlight(i) {
    if (!needBook()) return;
    const h = highlightAt(i);
    if (h) { await removeNote(h); toast(bookIsArabic ? 'أُزيل التظليل' : 'Highlight removed'); }
    else { await addNote('highlight', i); toast(bookIsArabic ? '🖍️ تم التظليل' : '🖍️ Highlighted'); }
  }
  async function addBookmark(i) {
    if (!needBook()) return;
    await addNote('bookmark', i);
    toast((bookIsArabic ? '🔖 حُفظت العلامة — ' : '🔖 Bookmarked — ') + placeLabel(sentences[i]));
  }
  function notesSheet() {
    if (!needBook()) return;
    const {d, body} = sheet('Bookmarks & highlights · العلامات', bookTitle());
    put(body, el('div', {class: 'btns'},
      button('🔖 Bookmark this place · علامة هنا', async () => { await addBookmark(current); d.close(); notesSheet(); }, true)));
    const list = el('div');
    put(body, list);
    const render = () => {
      list.innerHTML = '';
      const sorted = [...notes].sort((a, b) => resolveNote(a) - resolveNote(b));
      if (!sorted.length) put(list, el('p', {class: 'sub'}, 'Nothing saved yet. While listening, tap 🔖 or 🖍️, or tap a sentence. · لا يوجد شيء بعد.'));
      for (const n of sorted) {
        put(list, el('div', {class: 'row'},
          el('span', {style: 'font-size:22px'}, n.type === 'highlight' ? '🖍️' : '🔖'),
          el('div', {class: 'grow', style: 'cursor:pointer', role: 'button', tabindex: 0, onclick: () => { const i = resolveNote(n); d.close(); if (i >= 0) jumpTo(i); }},
            el('div', {class: 't'}, n.where || ('Page ' + n.pageNum)),
            el('div', {class: 'm', dir: dirOf(bookLang)}, n.text.slice(0, 140))),
          el('button', {class: 'icon-btn', 'aria-label': 'Delete', onclick: async () => { await removeNote(n); render(); }}, '🗑')));
      }
    };
    render();
  }

  // ---------------- learning mode & translation ----------------
  const learnOn = () => pref('learn', 'off') === 'on';
  function targetLang() {
    let t = pref('target', '');
    if (!t) t = bookLang === 'ar' ? 'en' : 'ar';
    if (t === bookLang) t = bookLang === 'ar' ? 'en' : 'ar';
    return t;
  }
  async function translateInto(box, text, from = bookLang) {
    const to = targetLang();
    box.hidden = false; box.dir = dirOf(to); box.textContent = '…';
    try { box.textContent = await QariAI.translate(text, from, to, geminiVoiceKey); }
    catch (e) {
      box.textContent = '';
      box.append(el('span', {class: 'err'}, e.message + ' '),
        el('a', {href: QariAI.googleTranslateLink(text, from, to), target: '_blank', rel: 'noopener'}, 'Google Translate ↗'));
    }
  }
  function learningSheet() {
    const {body} = sheet('Learning mode · وضع التعلّم', 'For learning the language of your book — e.g. Spanish.');
    const learn = el('input', {type: 'checkbox'}); learn.checked = learnOn();
    learn.onchange = () => { setPref('learn', learn.checked ? 'on' : 'off'); positionChanged(true); };
    const live = el('input', {type: 'checkbox'}); live.checked = pref('live', 'off') === 'on';
    live.onchange = () => { setPref('live', live.checked ? 'on' : 'off'); positionChanged(true); };
    const target = el('select', {'aria-label': 'Translate into'}, LANG_OPTS.map(([v, l]) => el('option', {value: v}, l)));
    target.value = targetLang();
    target.onchange = () => { setPref('target', target.value); positionChanged(true); };
    put(body, 
      el('label', {class: 'opt'}, learn, el('span', {}, 'Learning mode · تفعيل وضع التعلّم',
        el('small', {}, 'Tapping a sentence shows its translation and its words. Tap a word to see its meaning and save it to your word list.'))),
      el('label', {class: 'opt'}, live, el('span', {}, 'Show translation while listening · ترجمة أثناء الاستماع',
        el('small', {}, 'Shows the translation of what is being read under the player.'))),
      el('label', {style: 'display:block;margin:12px 0 4px'}, 'Translate into · الترجمة إلى'), target,
      el('p', {class: 'notice'}, geminiVoiceKey
        ? 'Translations use your free Gemini key.'
        : 'Free translation without a key allows about 5,000 letters a day. With your free Gemini key (Voice settings) it is much more generous and more accurate.'),
      el('div', {class: 'btns'}, button('🗂️ My word list · كلماتي', () => wordsSheet()), button('🃏 Practice · تدريب', () => flashcards())));
  }
  // Live caption under the player.
  let captionFor = '', captionTimer = null;
  function updateCaption(force) {
    const box = $('liveCaption');
    const on = learnOn() && pref('live', 'off') === 'on' && sentences.length && playing;
    if (!on) { box.hidden = true; captionFor = ''; return; }
    const text = naturalRange && isNatural()
      ? sentences.slice(naturalRange.start, naturalRange.end).map(s => s.text).join(' ')
      : sentences[current]?.text || '';
    if (!text || (text === captionFor && !force)) return;
    captionFor = text;
    clearTimeout(captionTimer);
    captionTimer = setTimeout(async () => {
      box.hidden = false; box.dir = dirOf(targetLang());
      try { const t = await QariAI.translate(text, bookLang, targetLang(), geminiVoiceKey); if (captionFor === text) box.textContent = t; }
      catch (e) { if (captionFor === text) box.textContent = e.message; }
    }, 250);
  }

  // ---------------- words ----------------
  function wordsOf(text) {
    const seen = new Set(), out = [];
    for (const w of text.match(/[\p{L}\p{M}][\p{L}\p{M}'’-]*/gu) || []) {
      const k = w.toLowerCase();
      if (k.length < 2 || seen.has(k)) continue;
      seen.add(k); out.push(w);
    }
    return out;
  }
  async function lookupInto(card, word, sentence) {
    const from = bookLang, to = targetLang();
    card.hidden = false; card.innerHTML = ''; put(card, el('div', {}, '… ' + word));
    try {
      const r = await QariAI.lookupWord(word, sentence, from, to, geminiVoiceKey);
      card.innerHTML = '';
      const saveBtn = button('⭐ Save word · احفظي الكلمة', async () => {
        const existing = (await bookStorage.words()).find(x => x.lang === from && (x.lemma || x.word).toLowerCase() === (r.lemma || word).toLowerCase());
        if (existing) { toast('Already in your word list · موجودة'); return; }
        await bookStorage.saveWord({id: uid(), word, lemma: r.lemma || word, translation: r.translation, pos: r.partOfSpeech || '', note: r.note || '',
          sentence, lang: from, target: to, book: bookTitle(), created: Date.now(), box: 0, due: Date.now()});
        saveBtn.disabled = true; saveBtn.textContent = '✓ Saved · حُفظت';
      }, true);
      put(card, 
        el('div', {style: 'display:flex;align-items:center;gap:8px'},
          el('b', {style: 'font-size:20px', dir: dirOf(from)}, r.lemma && r.lemma.toLowerCase() !== word.toLowerCase() ? word + ' → ' + r.lemma : word),
          el('button', {class: 'icon-btn', 'aria-label': 'Pronounce', onclick: () => deviceSpeak(r.lemma || word, 0.8, from)}, '🔊')),
        el('div', {dir: dirOf(to), style: 'font-size:18px;margin-top:4px'}, r.translation),
        r.partOfSpeech ? el('div', {class: 'sub', dir: dirOf(to)}, r.partOfSpeech) : null,
        r.note ? el('div', {class: 'sub', dir: dirOf(to)}, '💡 ' + r.note) : null,
        el('div', {class: 'btns'}, saveBtn));
    } catch (e) {
      card.innerHTML = '';
      put(card, el('span', {class: 'err'}, e.message + ' '), el('a', {href: QariAI.googleTranslateLink(word, from, to), target: '_blank', rel: 'noopener'}, 'Google Translate ↗'));
    }
  }
  async function wordsSheet() {
    const all = await bookStorage.words().catch(() => []);
    const due = all.filter(w => (w.due || 0) <= Date.now()).length;
    const {d, body} = sheet('My words · كلماتي', all.length + ' saved words · ' + due + ' to practise');
    put(body, el('div', {class: 'btns'},
      button('🃏 Practice · تدريب' + (due ? ' (' + due + ')' : ''), () => { d.close(); flashcards(); }, true),
      button('⬇ Export (Anki / Excel)', () => exportWords(all))));
    const search = el('input', {type: 'search', placeholder: 'Search · بحث'});
    const list = el('div');
    put(body, search, list);
    const render = () => {
      const q = search.value.trim().toLowerCase();
      list.innerHTML = '';
      const shown = all.filter(w => !q || [w.word, w.lemma, w.translation].join(' ').toLowerCase().includes(q));
      if (!shown.length) put(list, el('p', {class: 'sub'}, all.length ? 'No match.' : 'No words yet. Turn on Learning mode, tap a sentence, then tap a word. · لا توجد كلمات بعد.'));
      for (const w of shown) {
        put(list, el('div', {class: 'row'},
          el('button', {class: 'icon-btn', 'aria-label': 'Pronounce', onclick: () => deviceSpeak(w.lemma || w.word, 0.8, w.lang)}, '🔊'),
          el('div', {class: 'grow'},
            el('div', {class: 't'}, el('span', {dir: dirOf(w.lang)}, w.lemma || w.word), ' — ', el('span', {dir: dirOf(w.target)}, w.translation)),
            el('div', {class: 'm', dir: dirOf(w.lang)}, w.sentence || '')),
          el('button', {class: 'icon-btn', 'aria-label': 'Delete', onclick: async () => {
            await bookStorage.deleteWord(w.id); all.splice(all.indexOf(w), 1); render(); }}, '🗑')));
      }
    };
    search.oninput = render;
    render();
  }
  function exportWords(all) {
    if (!all.length) { toast('No words to export yet.'); return; }
    const esc = v => '"' + String(v || '').replace(/"/g, '""') + '"';
    const csv = ['word,translation,dictionary form,part of speech,note,example,language']
      .concat(all.map(w => [w.word, w.translation, w.lemma, w.pos, w.note, w.sentence, w.lang].map(esc).join(','))).join('\n');
    const a = el('a', {href: URL.createObjectURL(new Blob(['﻿' + csv], {type: 'text/csv;charset=utf-8'})), download: 'Qari-words.csv'});
    document.body.append(a); a.click(); a.remove();
    toast('Saved Qari-words.csv to Downloads');
  }
  const BOX_DAYS = [0, 1, 3, 7, 14, 30, 60];
  async function flashcards() {
    let all = await bookStorage.words().catch(() => []);
    if (!all.length) { toast('Save some words first — turn on Learning mode and tap a sentence.'); return; }
    let queue = all.filter(w => (w.due || 0) <= Date.now()).sort((a, b) => (a.due || 0) - (b.due || 0)).slice(0, 20);
    const extra = !queue.length;
    if (extra) queue = [...all].sort(() => Math.random() - .5).slice(0, 10);
    const {d, body} = sheet('Practice · تدريب', extra ? 'All caught up! Here is an extra round.' : queue.length + ' words to practise');
    let done = 0;
    const show = () => {
      body.innerHTML = '';
      const w = queue[0];
      if (!w) { put(body, el('div', {class: 'flash'}, el('div', {class: 'big'}, '🎉'), el('p', {}, 'Done for now! · أحسنتِ')), el('div', {class: 'btns'}, button('Close', () => d.close(), true))); return; }
      const back = el('div', {hidden: true},
        el('div', {style: 'font-size:22px;margin-top:12px', dir: dirOf(w.target)}, w.translation),
        w.note ? el('div', {class: 'sub', dir: dirOf(w.target)}, '💡 ' + w.note) : null,
        w.sentence ? el('div', {class: 'sub', dir: dirOf(w.lang), style: 'margin-top:10px'}, '“' + w.sentence + '”') : null);
      const grade = el('div', {class: 'btns', hidden: true, style: 'justify-content:center'},
        button('😕 Again · مرة أخرى', () => answer(false)), button('🙂 Got it · عرفتها', () => answer(true), true));
      const reveal = button('Show meaning · أظهري المعنى', () => { back.hidden = false; grade.hidden = false; reveal.remove(); }, true);
      put(body, el('p', {class: 'sub'}, (done + 1) + ' / ' + (done + queue.length)),
        el('div', {class: 'flash'},
          el('div', {class: 'big', dir: dirOf(w.lang)}, w.lemma || w.word),
          el('button', {class: 'icon-btn', style: 'margin-top:10px', 'aria-label': 'Pronounce', onclick: () => deviceSpeak(w.lemma || w.word, 0.8, w.lang)}, '🔊'),
          back),
        el('div', {class: 'btns', style: 'justify-content:center'}, reveal), grade);
      deviceSpeak(w.lemma || w.word, 0.85, w.lang);
    };
    const answer = async ok => {
      const w = queue.shift();
      if (ok) { w.box = Math.min((w.box || 0) + 1, BOX_DAYS.length - 1); w.due = Date.now() + BOX_DAYS[w.box] * 864e5; done++; }
      else { w.box = 0; w.due = Date.now(); queue.push(w); }
      await bookStorage.saveWord(w).catch(() => {});
      show();
    };
    show();
  }

  // ---------------- sentence options (tap a sentence) ----------------
  function sentenceSheet(i) {
    const s = sentences[i];
    if (!s) return;
    const {d, body} = sheet(placeLabel(s));
    const quote = el('div', {class: 'quote', dir: dirOf(bookLang)}, s.text);
    const trans = el('div', {class: 'trans', hidden: true});
    const status = el('span', {class: 'sub'});
    const h = highlightAt(i);
    const page = s.pageState;
    put(body, quote, trans,
      el('div', {class: 'btns'},
        button('▶ Play from here · شغّلي من هنا', () => { d.close(); stopOneShot(); jumpTo(i); if (!playing) play(); }, true),
        button('🐢 Slowly · ببطء', () => say(s.text, 0.7, bookLang, status)),
        button('🔁 Repeat · إعادة', () => say(s.text, 1, bookLang, status)),
        button('🌐 Translate · ترجمة', () => translateInto(trans, s.text)),
        button(h ? '🖍️ Remove highlight' : '🖍️ Highlight · تظليل', async () => { await toggleHighlight(i); d.close(); }),
        button('🔖 Bookmark · علامة', async () => { await addBookmark(i); d.close(); }),
        button('📋 Copy · نسخ', () => { navigator.clipboard?.writeText(s.text).then(() => toast('Copied · تم النسخ')).catch(() => {}); })),
      status);
    // Word chips: always available, open by default in learning mode.
    const card = el('div', {class: 'word-card', hidden: true});
    const chips = el('div', {class: 'chips', dir: dirOf(bookLang)});
    for (const w of wordsOf(s.text)) {
      const chip = el('button', {class: 'chip', onclick: () => {
        chips.querySelectorAll('.chip.on').forEach(c => c.classList.remove('on'));
        chip.classList.add('on'); lookupInto(card, w, s.text);
      }}, w);
      chips.append(chip);
    }
    const wordsBox = el('div', {hidden: !learnOn()},
      el('p', {class: 'sub', style: 'margin:10px 0 0'}, 'Tap a word to see its meaning and save it · اضغطي على كلمة'), chips, card);
    if (!learnOn()) put(body, el('div', {class: 'btns'}, button('🔤 Words · الكلمات', e => { wordsBox.hidden = false; e.target.remove(); })));
    put(body, wordsBox);
    // AI page tools
    if (page && geminiVoiceKey) {
      const tools = el('div', {class: 'btns'});
      if (page.ocr && !page.ai?.fixed) put(tools, button('✨ Fix this scanned page with AI', () => { d.close(); improveNow(page, {fix: true}); }));
      if (bookLang === 'ar' && !page.ai?.marks) put(tools, button('ـَ إضافة التشكيل لهذه الصفحة', () => { d.close(); improveNow(page, {tashkeel: true}); }));
      if (tools.children.length) put(body, tools);
    }
    if (learnOn()) translateInto(trans, s.text);
    d.onClosed = () => stopOneShot();
  }

  // ---------------- sleep timer ----------------
  let sleep = null, sleepTick = null;
  function clearSleep() { sleep = null; clearInterval(sleepTick); $('sleepLabel').textContent = ''; $('qSleep').classList.remove('on'); }
  function fadeAndStop() {
    clearSleep();
    if (!playing) return;
    if (isNatural() && !naturalAudio.paused) {
      let v = 1;
      const fade = setInterval(() => {
        v -= 0.05; naturalAudio.volume = Math.max(0, v);
        if (v <= 0 || !playing) { clearInterval(fade); stopSpeech(); naturalAudio.volume = 1; }
      }, 400);
    } else stopSpeech();
    toast(bookIsArabic ? '🌙 تصبحين على خير — توقّف الاستماع' : '🌙 Sleep timer — playback paused', 4000);
  }
  function setSleep(minutes) {
    clearSleep();
    if (minutes === 'chapter') {
      if (!sentences[current]) return;
      sleep = {mode: 'chapter', key: chapterKey(sentences[current])};
      $('sleepLabel').textContent = bookIsArabic ? 'فصل' : 'end';
      $('qSleep').classList.add('on');
      return;
    }
    if (!minutes) return;
    sleep = {mode: 'time', end: Date.now() + minutes * 60000};
    $('qSleep').classList.add('on');
    const tick = () => {
      const left = sleep.end - Date.now();
      if (left <= 0) { fadeAndStop(); return; }
      const m = Math.floor(left / 60000), sec = Math.floor(left / 1000) % 60;
      $('sleepLabel').textContent = m + ':' + String(sec).padStart(2, '0');
    };
    tick(); sleepTick = setInterval(tick, 1000);
  }
  function sleepSheet() {
    const {d, body} = sheet('Sleep timer · مؤقت النوم', sleep ? (sleep.mode === 'time' ? 'Running: ' + $('sleepLabel').textContent + ' left' : 'Stops at the end of this chapter') : 'Stop listening automatically.');
    const choose = m => () => { setSleep(m); d.close(); if (m) toast('🌙 ' + (m === 'chapter' ? 'Stops at the end of this chapter' : 'Stops in ' + m + ' min')); };
    put(body, el('div', {class: 'btns'},
      [5, 10, 15, 20, 30, 45, 60].map(m => button(m + ' min', choose(m))),
      button(sentences[current]?.label ? '📖 End of chapter · نهاية الفصل' : '📄 End of page · نهاية الصفحة', choose('chapter')),
      sleep ? button('✕ Turn off · إيقاف المؤقت', () => { clearSleep(); d.close(); }, true) : null));
  }
  Q.passageLimit = s => !sleep || sleep.mode !== 'chapter' || chapterKey(s) === sleep.key;
  function checkSleepChapter() {
    if (!sleep || sleep.mode !== 'chapter' || !playing) return;
    const now = sentences[current];
    if (!now || chapterKey(now) === sleep.key) return;
    const prev = sentences[current - 1];
    if (prev && chapterKey(prev) === sleep.key) fadeAndStop();   // finished the chapter
    else sleep.key = chapterKey(now);                            // listener jumped elsewhere
  }

  // ---------------- recap ----------------
  function recapSheet() {
    if (!needBook()) return;
    const s = sentences[current];
    const hasChapters = !!s?.label;
    const {body} = sheet('Recap · ملخص ما سبق', 'A reminder of what you have heard so far — nothing after where you stopped.');
    const scope = el('select', {'aria-label': 'What to recap'},
      el('option', {value: 'chapter'}, hasChapters ? 'This chapter so far · هذا الفصل' : 'Last 10 pages · آخر ١٠ صفحات'),
      el('option', {value: 'book'}, 'Whole book so far · الكتاب حتى الآن'));
    const lang = el('select', {'aria-label': 'Recap language'}, LANG_OPTS.map(([v, l]) => el('option', {value: v}, l)));
    lang.value = learnOn() ? targetLang() : bookLang;
    const out = el('div');
    const go = button('📝 Make recap · لخّصي', async () => {
      go.disabled = true; out.innerHTML = ''; put(out, el('p', {class: 'sub'}, '…'));
      const upto = Math.max(1, current);
      let from = 0;
      if (scope.value === 'chapter') {
        if (hasChapters) { from = upto - 1; while (from > 0 && chapterKey(sentences[from - 1]) === chapterKey(s)) from--; }
        else { const pages = [...new Set(sentences.slice(0, upto).map(x => x.pageNum))].slice(-10); from = sentences.findIndex(x => x.pageNum === pages[0]); }
      }
      const part = sentences.slice(Math.max(0, from), upto).filter(x => !pageIsSkipped(x.pageState)).map(x => x.text);
      if (part.join(' ').length < 80) { out.innerHTML = ''; put(out, el('p', {class: 'sub'}, 'Listen a little further first — there is not enough yet to recap.')); go.disabled = false; return; }
      let bullets = [], free = false;
      try {
        if (geminiVoiceKey) {
          const text = await QariAI.recap(part.join(' '), bookLang, lang.value, geminiVoiceKey, scope.value === 'book' ? 'the book so far' : 'the current chapter so far');
          bullets = text.split(/\n+/).map(l => l.replace(/^\s*[•\-*]\s*/, '').trim()).filter(Boolean);
        } else {
          free = true;
          bullets = QariAI.extractiveSummary(part);
          if (lang.value !== bookLang && bullets.join(' ').length < 1500) {
            try { bullets = (await QariAI.translate(bullets.join('\n'), bookLang, lang.value, null)).split(/\n+/).filter(Boolean); }
            catch { /* keep original language */ }
          }
        }
      } catch (e) { out.innerHTML = ''; put(out, el('p', {class: 'err'}, e.message)); go.disabled = false; return; }
      const outLang = free && !bullets.some(b => /[؀-ۿ]/.test(b)) && lang.value === 'ar' ? bookLang : lang.value;
      out.innerHTML = '';
      put(out, el('ul', {class: 'recap', dir: dirOf(outLang)}, bullets.map(b => el('li', {}, '• ' + b))),
        free ? el('p', {class: 'notice'}, 'Free recap: the key sentences so far. Add your free Gemini key (Voice settings) for a written recap in your language.') : null,
        el('div', {class: 'btns'},
          button('🔊 Read aloud · استمعي', () => say(bullets.join('. '), 1, outLang)),
          button('📋 Copy', () => navigator.clipboard?.writeText(bullets.map(b => '• ' + b).join('\n')).then(() => toast('Copied')))));
      go.disabled = false;
    }, true);
    put(body, el('label', {style: 'display:block;margin:6px 0 4px'}, 'What · ماذا'), scope,
      el('label', {style: 'display:block;margin:10px 0 4px'}, 'Language · اللغة'), lang,
      el('div', {class: 'btns'}, go), out);
  }

  // ---------------- offline downloads ----------------
  const dlEngine = new QariNaturalVoice();
  let offline = new Set(), offlineSorted = [], dlJob = null;
  const voiceTag = () => $('narratorSel').value + '|' + voiceLanguage();
  const offKey = start => [activeBook.id, $('narratorSel').value, voiceLanguage(), start].join('|');
  async function refreshOffline() {
    if (!activeBook) { offline = new Set(); offlineSorted = []; return {count: 0, bytes: 0}; }
    const sum = await bookStorage.offlineSummary(activeBook.id).catch(() => ({count: 0, bytes: 0, starts: new Set()}));
    // stored starts are plain numbers per book; key lookups confirm voice + language
    const items = await Promise.all([...sum.starts].map(async st => (await bookStorage.offline(offKey(st)).catch(() => null)) ? st : null));
    offlineSorted = items.filter(x => x !== null).sort((a, b) => a - b);
    offline = new Set(offlineSorted.map(st => voiceTag() + '|' + st));
    return sum;
  }
  Q.hasOfflineAt = i => offline.has(voiceTag() + '|' + i);
  Q.nextOfflineStart = i => offlineSorted.find(st => st > i && offline.has(voiceTag() + '|' + st));
  Q.offlineAudio = async i => {
    if (!activeBook || !Q.hasOfflineAt(i)) return null;
    const rec = await bookStorage.offline(offKey(i)).catch(() => null);
    if (!rec) return null;
    const text = sentences.slice(rec.start, rec.end).map(s => s.text).join(' ');
    return text === rec.text ? rec : null;
  };
  $('narratorSel').addEventListener('change', () => refreshOffline());
  async function runDownload(limitChars, chapterOnly, ui) {
    const bookId = activeBook.id, voice = $('narratorSel').value, lang = voiceLanguage(), key = geminiVoiceKey;
    let i = nextReadable(current);
    const chapter = chapterKey(sentences[i]);
    const plan = [];
    let chars = 0;
    while (i < sentences.length && chars < limitChars) {
      const r = QariNaturalVoice.passage(sentences, i, 1100, s => !pageIsSkipped(s.pageState) && (!chapterOnly || chapterKey(s) === chapter));
      if (r.end <= r.start) break;
      plan.push(r); chars += r.text.length;
      i = nextReadable(r.end);
      if (chapterOnly && chapterKey(sentences[i]) !== chapter) break;
    }
    if (!plan.length) throw new Error('Nothing left to download here.');
    const job = dlJob = {cancel: false, done: 0, total: plan.length, msg: ''};
    keepAwake(true);
    try {
      for (const r of plan) {
        if (job.cancel || activeBook?.id !== bookId) break;
        const k = [bookId, voice, lang, r.start].join('|');
        if (!(await bookStorage.offline(k).catch(() => null))) {
          let blob = null;
          for (let attempt = 0; attempt < 6 && !blob && !job.cancel; attempt++) {
            try { blob = await dlEngine.generate(r.text, key, voice, lang); }
            catch (e) {
              if (!/limit|timed out|connect/i.test(e.message) || attempt === 5) throw e;
              for (let s = 60; s > 0 && !job.cancel; s--) { job.msg = 'Free limit reached — continuing in ' + s + ' s · انتظار'; ui?.(); await sleepMs(1000); }
              job.msg = '';
            }
          }
          if (!blob) break;
          await bookStorage.saveOffline({key: k, bookId, start: r.start, end: r.end, text: r.text, blob, voice, lang, created: Date.now()});
        }
        job.done++; ui?.();
      }
    } finally {
      if (!playing) keepAwake(false);
      await refreshOffline();
      dlJob = null; ui?.();
    }
    return job;
  }
  async function offlineSheet() {
    if (!needBook()) return;
    const {body} = sheet('Listen offline · الاستماع دون إنترنت', 'Prepare the Natural voice in advance, so it plays without internet (e.g. on a plane).');
    const info = el('p', {class: 'sub'});
    const bar = el('div', {class: 'bar'}, el('div'));
    const status = el('p', {class: 'sub', role: 'status'});
    const opts = el('div', {class: 'btns'});
    const cancel = button('✕ Stop downloading', () => { if (dlJob) dlJob.cancel = true; });
    const ui = async () => {
      const sum = await refreshOffline();
      info.textContent = sum.count ? '⬇ ' + sum.count + ' passages saved · ' + (sum.bytes / 1048576).toFixed(0) + ' MB on this device' : 'Nothing downloaded for this book yet.';
      if (dlJob) {
        bar.hidden = false; bar.firstChild.style.width = Math.round(dlJob.done / dlJob.total * 100) + '%';
        status.textContent = dlJob.msg || ('Preparing ' + dlJob.done + ' of ' + dlJob.total + '… you can close this window.');
        opts.hidden = true; cancel.hidden = false;
      } else { bar.hidden = true; opts.hidden = false; cancel.hidden = true; }
    };
    if (!isNatural()) put(body, el('p', {class: 'notice'}, 'You are using Device voice, which already works without internet. Downloads are for the Natural voice.'));
    if (!geminiVoiceKey) put(body, el('p', {class: 'notice'}, 'Downloading the Natural voice needs your free Gemini key.'), el('div', {class: 'btns'}, button('🔑 Voice settings', () => openVoiceSettings(), true)));
    const start = (chars, chapterOnly) => async () => {
      try { await runDownload(chars, chapterOnly, ui); toast('⬇ Ready to listen offline · جاهز دون إنترنت', 4000); }
      catch (e) { status.textContent = e.message; toast(e.message, 5000); }
      ui();
    };
    const CPM = 850; // letters read per minute, roughly
    if (geminiVoiceKey) put(opts, 
      button('15 min', start(15 * CPM)), button('30 min', start(30 * CPM), true), button('1 hour', start(60 * CPM)),
      button(sentences[current]?.label ? 'Rest of chapter · بقية الفصل' : 'Rest of page', start(1e9, true)),
      button('Whole book (slow, large)', start(1e9)));
    const clear = button('🗑 Remove downloads for this book', async () => { await bookStorage.clearOffline(activeBook.id); ui(); });
    put(body, el('p', {class: 'sub'}, 'Narrator: ' + $('narratorSel').value + ' · ~3 MB per minute of audio.'), info, bar, status, opts, el('div', {class: 'btns'}, cancel, clear));
    ui();
  }

  // ---------------- AI page pass: OCR fix + tashkeel ----------------
  let aiBusy = false, aiPauseUntil = 0;
  const aiFailed = new Set();
  const hasMarks = t => ((t.match(/[ً-ْ]/g) || []).length / Math.max(1, (t.match(/[ء-ي]/g) || []).length)) > 0.2;
  async function improveNow(page, what) {
    if (!geminiVoiceKey) { toast('This needs your free Gemini key (Voice settings).'); return; }
    toast(what.fix ? '✨ Fixing this page…' : 'ـَ جارٍ إضافة التشكيل…', 4000);
    try {
      const out = await QariAI.improvePage(page.text, bookLang, what, geminiVoiceKey);
      replacePageText(page.pageNum, out, {fixed: page.ai?.fixed || !!what.fix, marks: page.ai?.marks || !!what.tashkeel});
      toast('✓ Page updated · تم تحديث الصفحة');
    } catch (e) { toast(e.message, 5000); }
  }
  async function aiPump() {
    if (aiBusy || !geminiVoiceKey || !activeBook || Date.now() < aiPauseUntil) return;
    const wantFix = pref('aiFix', 'off') === 'on', wantMarks = pref('tashkeel', 'off') === 'on' && bookLang === 'ar';
    if (!wantFix && !wantMarks) return;
    const pages = [...readerPages.values()];
    const here = pages.indexOf(sentences[current]?.pageState);
    const candidates = pages.slice(playing ? here + 1 : Math.max(0, here), here + 4);
    for (const p of candidates) {
      if (aiFailed.has(p.pageNum) || pageIsSkipped(p)) continue;
      const needFix = wantFix && p.ocr && !p.ai?.fixed;
      const needMarks = wantMarks && !p.ai?.marks && !hasMarks(p.text);
      if (!needFix && !needMarks) continue;
      const first = sentences.findIndex(s => s.pageState === p);
      if (playing && naturalRange && first < naturalRange.end) continue;   // being read right now
      aiBusy = true;
      const bookId = activeBook.id;
      try {
        const out = await QariAI.improvePage(p.text, bookLang, {fix: needFix, tashkeel: needMarks}, geminiVoiceKey);
        if (activeBook?.id === bookId && readerPages.get(p.pageNum) === p)
          replacePageText(p.pageNum, out, {fixed: p.ai?.fixed || needFix, marks: p.ai?.marks || needMarks});
      } catch (e) {
        if (/limit/i.test(e.message)) aiPauseUntil = Date.now() + 60000; else aiFailed.add(p.pageNum);
      } finally { aiBusy = false; }
      setTimeout(aiPump, 1500);
      return;
    }
  }
  function pagesSheet() {
    const {body} = sheet('Clean-up & vowel marks · تنظيف وتشكيل', 'Make scanned books and Arabic text read better.');
    const opt = (label, small, checked, onchange, disabled) => {
      const box = el('input', {type: 'checkbox', disabled}); box.checked = checked; box.onchange = () => onchange(box.checked);
      return el('label', {class: 'opt'}, box, el('span', {}, label, el('small', {}, small)));
    };
    const s = sentences[current], page = s?.pageState;
    put(body, 
      opt('Clean up PDFs (free) · تنظيف مجاني', 'Removes page numbers, repeated headers/footers and junk symbols, so they are not read aloud. Applies to newly opened PDFs.',
        storedVoice('cleanup') !== 'off', v => saveVoiceSetting('cleanup', v ? 'on' : 'off')),
      opt('Fix scanned pages with AI · تصحيح الصفحات الممسوحة', 'Corrects recognition mistakes a few pages ahead of where you are listening. Needs your free Gemini key.',
        pref('aiFix', 'off') === 'on', v => { setPref('aiFix', v ? 'on' : 'off'); aiPump(); }, !geminiVoiceKey),
      opt('إضافة التشكيل للنص العربي · Arabic vowel marks', 'يضيف الحركات للصفحات القادمة لنطق أصحّ. Adds tashkeel a few pages ahead for correct pronunciation. Needs your free Gemini key.',
        pref('tashkeel', 'off') === 'on', v => { setPref('tashkeel', v ? 'on' : 'off'); aiPump(); }, !geminiVoiceKey));
    if (!geminiVoiceKey) put(body, el('p', {class: 'notice'}, 'The AI options need your free Gemini key.'), el('div', {class: 'btns'}, button('🔑 Voice settings', () => openVoiceSettings(), true)));
    else if (page) put(body, el('p', {class: 'sub', style: 'margin-top:12px'}, 'This page now (' + placeLabel(s) + '):'),
      el('div', {class: 'btns'},
        button('✨ Fix this page', () => improveNow(page, {fix: true})),
        bookLang === 'ar' ? button('ـَ شكّلي هذه الصفحة', () => improveNow(page, {tashkeel: true})) : null));
  }

  // ---------------- book finder ----------------
  function finderSheet() {
    const {d, body} = sheet('Find a book · ابحث عن كتاب', 'Scan a cover or barcode, or type a title. Free books open right in Qari.');
    const file = el('input', {type: 'file', accept: 'image/*', capture: 'environment', hidden: true});
    const q = el('input', {type: 'search', placeholder: 'Title, author or ISBN · العنوان أو المؤلف', enterkeyhint: 'search'});
    const status = el('p', {class: 'sub', role: 'status'});
    const results = el('div');
    const links = el('p', {class: 'sub'});
    const search = async (query) => {
      query = (query || q.value).trim();
      if (!query) return;
      status.textContent = 'Searching… · جارٍ البحث'; results.innerHTML = '';
      renderLinks(query);
      let list = [];
      try { list = await QariAI.searchBooks(query); } catch { /* handled below */ }
      if (!list.length) { status.textContent = 'No results. Try fewer words, or the author name. · لا نتائج'; return; }
      status.textContent = list.filter(r => r.download).length ? '🟢 Free books are listed first.' : 'Not free online — see where to get it below.';
      for (const r of list) put(results, resultCard(r, d, status));
    };
    const renderLinks = query => {
      links.innerHTML = '';
      const g = encodeURIComponent(query);
      put(links, 'More places: ',
        el('a', {href: 'https://www.google.com/search?q=' + encodeURIComponent('site:hindawi.org ' + query), target: '_blank', rel: 'noopener'}, 'Hindawi (free Arabic books)'), ' · ',
        el('a', {href: 'https://www.gutenberg.org/ebooks/search/?query=' + g, target: '_blank', rel: 'noopener'}, 'Project Gutenberg'), ' · ',
        el('a', {href: 'https://www.google.com/search?tbm=bks&q=' + g, target: '_blank', rel: 'noopener'}, 'Google Books'));
    };
    file.onchange = async () => {
      const f = file.files?.[0]; file.value = '';
      if (!f) return;
      results.innerHTML = '';
      try {
        status.textContent = '📷 Looking for a barcode… · قراءة الغلاف';
        const isbn = await QariAI.readBarcode(f);
        if (isbn) { q.value = isbn; return search(isbn); }
        const small = await QariAI.shrinkImage(f);
        if (geminiVoiceKey) {
          status.textContent = '📷 Recognizing the cover… · التعرّف على الغلاف';
          try {
            const r = await QariAI.identifyCover(small, geminiVoiceKey);
            const query = r.isbn && r.isbn.length >= 10 ? r.isbn : [r.title, r.author].filter(Boolean).join(' ');
            if (query) { q.value = query; return search(query); }
          } catch (e) { status.textContent = e.message; }
        }
        status.textContent = '📷 Reading the title from the photo (free)… · قراءة العنوان';
        const query = await ocrCover(small);
        if (!query) { status.textContent = 'Could not read the cover. Type the title instead. · اكتبي العنوان'; q.focus(); return; }
        q.value = query;
        status.textContent = 'Read: “' + query + '” — edit it if needed.';
        search(query);
      } catch (e) { status.textContent = e.message || 'Could not read the photo.'; }
    };
    q.addEventListener('keydown', e => { if (e.key === 'Enter') search(); });
    put(body, 
      el('div', {class: 'btns'}, button('📷 Scan cover or barcode · صوّري الغلاف', () => file.click(), true)), file,
      el('div', {style: 'display:flex;gap:8px'}, q, button('🔍', () => search())),
      geminiVoiceKey ? null : el('p', {class: 'notice'}, 'Free: barcodes and clear cover titles work without a key. With your free Gemini key, any cover photo is recognized.'),
      status, results, links);
  }
  async function ocrCover(blob) {
    if (!window.Tesseract) await loadScript([
      'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js',
      'https://unpkg.com/tesseract.js@5/dist/tesseract.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.0/tesseract.min.js']);
    const w = await Tesseract.createWorker('eng+spa+ara', 1);
    try {
      const {data} = await w.recognize(blob);
      const lines = (data.lines || [])
        .filter(l => (l.text.match(/\p{L}/gu) || []).length >= 3 && (l.confidence || 0) > 45)
        .map(l => ({t: l.text.trim(), h: l.bbox.y1 - l.bbox.y0}))
        .sort((a, b) => b.h - a.h);
      return lines.slice(0, 2).map(l => l.t).join(' ').replace(/[^\p{L}\p{M}\p{N}\s'’-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
    } finally { await w.terminate(); }
  }
  function resultCard(r, dialog, status) {
    const img = r.cover ? el('img', {src: r.cover, alt: '', loading: 'lazy', onerror: e => e.target.replaceWith(el('div', {class: 'nocover'}, '📕'))}) : el('div', {class: 'nocover'}, '📕');
    const btns = el('div', {class: 'btns'});
    if (r.download) btns.append(button('▶ Get free & listen · استمعي مجاناً', () => getFree(r, dialog, status), true));
    if (r.freePage) btns.append(el('a', {class: 'btn', href: r.freePage, target: '_blank', rel: 'noopener'}, 'Free online'));
    if (r.info) btns.append(el('a', {class: 'btn', href: r.info, target: '_blank', rel: 'noopener'}, 'Details'));
    if (!r.download) btns.append(el('a', {class: 'btn', href: 'https://www.google.com/search?q=' + encodeURIComponent(r.title + ' ' + (r.author || '') + ' ebook'), target: '_blank', rel: 'noopener'}, '🛒 Where to get it'));
    return el('div', {class: 'result'}, img,
      el('div', {class: 'grow', style: 'min-width:0'},
        el('div', {class: 't', dir: 'auto'}, r.title),
        el('div', {class: 'm', dir: 'auto'}, [r.author, r.year].filter(Boolean).join(' · ')),
        el('span', {class: 'tag' + (r.download ? ' free' : '')}, (r.download ? 'Free · ' : '') + r.source),
        r.about ? el('div', {class: 'm', dir: 'auto', style: 'margin-top:4px'}, r.about + '…') : null,
        btns));
  }
  async function getFree(r, dialog, status) {
    status.textContent = 'Downloading the free book… · جارٍ التنزيل';
    try {
      const res = await fetch(r.download);
      if (!res.ok) throw new Error('http ' + res.status);
      const blob = await res.blob();
      if (blob.size < 1500) throw new Error('empty');
      const type = r.downloadType === 'epub' ? 'application/epub+zip' : r.downloadType === 'pdf' ? 'application/pdf' : 'text/plain';
      const name = (r.title || 'Book').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80) + '.' + r.downloadType;
      dialog.close();
      await openFiles([new File([blob], name, {type})]);
    } catch {
      window.open(r.download, '_blank', 'noopener');
      status.textContent = 'The book opened in a new tab to download. When it is saved, tap “Open a book” and choose it. · بعد التنزيل اختاري «فتح كتاب»';
    }
  }

  // ---------------- library ----------------
  function closeBook() {
    stopSpeech(); resetNatural(); processingId++;
    activeBook = null; sentences = []; readerPages.clear(); current = 0;
    $('textPane').innerHTML = ''; $('reader').style.display = 'none'; $('player').style.display = 'none';
    $('ocrChip').style.display = 'none'; $('emptyState').style.display = 'flex';
    notes = []; offline = new Set(); offlineSorted = [];
  }
  async function librarySheet() {
    const books = await bookStorage.list().catch(() => []);
    const {d, body} = sheet('My library · مكتبتي', books.length ? books.length + (books.length === 1 ? ' book' : ' books') + ' saved on this device' : 'Books you open are saved here.');
    put(body, el('div', {class: 'btns'},
      button('📂 Open a book · فتح كتاب', () => { d.close(); $('fileInput').value = ''; $('fileInput').click(); }, true),
      button('🔍 Find a book · ابحث', () => { d.close(); finderSheet(); })));
    for (const b of books) {
      const pct = b.total ? Math.min(100, Math.round((b.currentSentence || 0) / b.total * 100)) : 0;
      const isNow = b.id === activeBook?.id;
      const del = el('button', {class: 'icon-btn', 'aria-label': 'Remove from library'}, '🗑');
      del.onclick = async () => {
        if (del.dataset.sure !== '1') { del.dataset.sure = '1'; del.textContent = '✓?'; toast('Tap again to remove this book · اضغطي مرة أخرى للحذف'); setTimeout(() => { del.dataset.sure = ''; del.textContent = '🗑'; }, 3000); return; }
        await bookStorage.remove(b.id);
        if (isNow) closeBook();
        d.close(); librarySheet();
      };
      put(body, el('div', {class: 'row'},
        el('span', {style: 'font-size:26px'}, isNow ? '📖' : '📕'),
        el('div', {class: 'grow', style: 'cursor:pointer', role: 'button', tabindex: 0, onclick: async () => {
          d.close(); if (!isNow) { if (!(await openSavedBook(b.id))) toast('Could not open this book.'); } }},
          el('div', {class: 't', dir: 'auto'}, (b.name || 'Book').replace(/\.(pdf|txt|epub)$/i, '')),
          el('div', {class: 'm'}, (isNow ? 'Now reading · ' : '') + pct + '%' + (b.where ? ' · ' + (typeof b.where === 'number' ? 'p. ' + b.where : b.where) : '') +
            (b.opened ? ' · ' + new Date(b.opened).toLocaleDateString() : ''))),
        del));
    }
  }

  // ---------------- voice & reading panel, speed ----------------
  function syncSpeed() { $('speedBtn').textContent = parseFloat($('rateSel').value) + '×'; }
  function speedSheet() {
    const {d, body} = sheet('Speed · السرعة');
    const now = $('rateSel').value;
    put(body, el('div', {class: 'btns'}, [...$('rateSel').options].map(o =>
      button(parseFloat(o.value) + '×', () => { $('rateSel').value = o.value; $('rateSel').dispatchEvent(new Event('change')); d.close(); }, o.value === now))));
  }
  // Moves the player's own voice controls into a panel, and back when it closes.
  function voiceSheet() {
    const {d, body} = sheet('Voice & reading · الصوت والقراءة');
    const parts = ['voiceModeRow', 'settingsRow', 'pageTools'].map(id => $(id));
    const lbl = t => el('p', {class: 'sub', style: 'margin:14px 0 6px'}, t);
    put(body, lbl('Voice · الصوت'), parts[0], lbl(isNatural() ? 'Speed · السرعة' : 'Speed and phone voice · السرعة وصوت الجهاز'), parts[1],
      lbl('Pages · الصفحات'), parts[2]);
    d.onClosed = () => { parts.forEach(p => $('playerSettings').append(p)); syncSpeed(); };
  }

  // ---------------- menu ----------------
  function menuSheet() {
    const {d, body} = sheet('Qari');
    const item = (ico, title, small, fn) => el('button', {onclick: () => { d.close(); fn(); }},
      el('span', {class: 'ico'}, ico), el('span', {}, title, small ? el('small', {}, small) : null));
    put(body, el('div', {class: 'menu-list'},
      item('📂', 'Open a book · فتح كتاب', 'PDF, EPUB or text', () => { $('fileInput').value = ''; $('fileInput').click(); }),
      item('🔍', 'Find a book · ابحث عن كتاب', 'Scan a cover or barcode — free books open right away', finderSheet),
      item('📚', 'My library · مكتبتي', 'All your books and where you stopped', librarySheet),
      item('🔖', 'Bookmarks & highlights · العلامات', null, notesSheet),
      item('🎓', 'Learning mode · وضع التعلّم', learnOn() ? 'On — translations and word saving' : 'Translate sentences, save words', learningSheet),
      item('🗂️', 'My words & practice · كلماتي', 'Flashcards, export to Anki', wordsSheet),
      item('📝', 'Recap · ملخص ما سبق', 'What happened so far', recapSheet),
      item('⬇️', 'Listen offline · دون إنترنت', 'Download the next chapter in advance', offlineSheet),
      item('🌙', 'Sleep timer · مؤقت النوم', sleep ? 'On' : null, sleepSheet),
      item('✨', 'Clean-up & vowel marks · التنظيف والتشكيل', 'Better scanned books, tashkeel for Arabic', pagesSheet),
      item('⚙️', 'Voice & reading · الصوت والقراءة', isNatural() ? 'Natural voice · ' + $('narratorSel').value : 'Device voice', voiceSheet),
      sentences.length ? item('📄', 'Export text · تصدير النص', null, () => $('exportBtn').click()) : null));
  }

  // ---------------- wiring ----------------
  let lastPump = 0;
  function positionChanged(force) {
    checkSleepChapter();
    updateCaption(force === true);
    if (Date.now() - lastPump > 4000) { lastPump = Date.now(); aiPump(); }
  }
  Q.positionChanged = positionChanged;
  Q.sentenceTap = i => sentenceSheet(i);
  Q.pageAdded = () => { if (notes.length) applyNotes(); setTimeout(aiPump, 500); };
  Q.bookOpened = () => {
    aiFailed.clear(); captionFor = ''; $('liveCaption').hidden = true;
    if (sleep?.mode === 'chapter') clearSleep();
    notes = []; offline = new Set(); offlineSorted = [];
    // activeBook is set by the caller before pages are added
    setTimeout(() => { loadNotes(); refreshOffline(); }, 0);
  };
  $('qBookmark').onclick = () => addBookmark(current);
  $('qHighlight').onclick = () => toggleHighlight(current);
  $('qSleep').onclick = sleepSheet;
  $('qRecap').onclick = recapSheet;
  $('qMore').onclick = menuSheet;
  $('qVoice').onclick = voiceSheet;
  $('speedBtn').onclick = speedSheet;
  $('rateSel').addEventListener('change', syncSpeed);
  syncSpeed();
  $('menuBtn').onclick = menuSheet;
  $('libraryBtn').onclick = librarySheet;
  $('emptyFindBtn').onclick = finderSheet;
  $('emptyLibraryBtn').onclick = librarySheet;
  // A book may already have been restored before this file loaded.
  if (activeBook && sentences.length) Q.bookOpened();

  window.QariFeatures = {sentenceSheet, librarySheet, finderSheet, menuSheet, recapSheet, wordsSheet, flashcards, notesSheet,
    sleepSheet, offlineSheet, pagesSheet, learningSheet, voiceSheet, speedSheet, setSleep, addBookmark, toggleHighlight};
})();
