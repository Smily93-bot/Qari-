/* Qari helpers: optional Gemini (free tier key) for text/vision, plus free no-key
   services: MyMemory translation, Open Library / Google Books / Gutendex search,
   on-device summary and scan clean-up. */
(function (root) {
  'use strict';

  const LANG_LABEL = {ar: 'Arabic', en: 'English', es: 'Spanish', fr: 'French', de: 'German'};

  // ---------------- Gemini (optional) ----------------
  const MODELS = {
    fast: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-flash-lite-latest'],
    smart: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-flash-latest']
  };
  function outputText(data) {
    if (typeof data?.output_text === 'string') return data.output_text;
    const parts = [];
    for (const step of data?.steps || []) {
      if (step.type && step.type !== 'model_output') continue;
      for (const c of step.content || []) if (c && c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    }
    if (!parts.length) for (const o of data?.outputs || []) if (o && o.type === 'text' && typeof o.text === 'string') parts.push(o.text);
    return parts.join('');
  }
  async function gemini({key, tier = 'fast', prompt, image, schema, timeout = 90000, signal}) {
    if (!key) throw new Error('This needs your free Gemini key (Voice settings).');
    let lastError;
    for (const model of MODELS[tier]) {
      const controller = new AbortController();
      const stop = () => controller.abort();
      signal?.addEventListener('abort', stop);
      const timer = setTimeout(stop, timeout);
      try {
        const input = image ? [{type: 'text', text: prompt}, {type: 'image', data: image.data, mime_type: image.mime}] : prompt;
        const body = {model, store: false, input};
        if (schema) body.response_format = {type: 'text', mime_type: 'application/json', schema};
        const res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
          method: 'POST', signal: controller.signal,
          headers: {'Content-Type': 'application/json', 'x-goog-api-key': key}, body: JSON.stringify(body)
        });
        if (res.status === 404) { lastError = new Error('Model unavailable'); continue; }
        if (res.status === 429) throw new Error('Gemini free limit reached for now. Wait a minute and try again.');
        if ([400, 401, 403].includes(res.status)) throw new Error('Gemini did not accept the key. Check it in Voice settings.');
        if (!res.ok) throw new Error('Gemini could not answer. Please retry.');
        const text = outputText(await res.json()).trim();
        if (!text) throw new Error('Gemini returned an empty answer. Please retry.');
        if (!schema) return text;
        return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
      } catch (e) {
        if (e.name === 'AbortError') throw new Error(signal?.aborted ? 'Cancelled' : 'Gemini took too long. Check your connection.');
        if (e instanceof TypeError) throw new Error('Could not reach Gemini. Check your internet connection.');
        throw e;
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
    }
    throw lastError || new Error('Gemini is unavailable.');
  }

  // ---------------- Translation (free without key) ----------------
  const tCache = new Map();
  function chunks(text, maxBytes = 450) {
    const enc = new TextEncoder(), out = [];
    let cur = '';
    for (const word of text.split(/(\s+)/)) {
      if (enc.encode(cur + word).length > maxBytes && cur.trim()) { out.push(cur.trim()); cur = ''; }
      cur += word;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  async function myMemory(text, from, to) {
    const parts = [];
    for (const piece of chunks(text)) {
      const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(piece) + '&langpair=' + from + '|' + to;
      let data;
      try { data = await (await fetch(url)).json(); } catch { throw new Error('Free translation is unreachable right now.'); }
      const t = data?.responseData?.translatedText || '';
      if (/MYMEMORY WARNING|QUOTA/i.test(t) || data?.quotaFinished || data?.responseStatus == 429) throw new Error('Free translation limit for today is used up. Add a free Gemini key for unlimited use, or open Google Translate.');
      if (data?.responseStatus && data.responseStatus != 200) throw new Error(data.responseDetails || 'Free translation failed.');
      parts.push(t);
    }
    const tmp = document.createElement('textarea');
    tmp.innerHTML = parts.join(' ');   // decode HTML entities such as &#39;
    return tmp.value;
  }
  async function translate(text, from, to, key) {
    text = (text || '').trim();
    if (!text || from === to) return text;
    const ck = [from, to, text].join('|');
    if (tCache.has(ck)) return tCache.get(ck);
    const result = key
      ? await gemini({key, prompt: 'Translate this ' + (LANG_LABEL[from] || from) + ' text into ' + (LANG_LABEL[to] || to) + '. Reply with the translation only, nothing else.\n\n' + text})
      : await myMemory(text, from, to);
    tCache.set(ck, result);
    return result;
  }
  async function lookupWord(word, sentence, from, to, key) {
    if (key) {
      try {
        return await gemini({key, schema: {type: 'object', properties: {
          lemma: {type: 'string'}, translation: {type: 'string'}, partOfSpeech: {type: 'string'}, note: {type: 'string'}},
          required: ['translation']},
          prompt: 'A ' + (LANG_LABEL[to] || to) + ' speaker learning ' + (LANG_LABEL[from] || from) + ' tapped the word "' + word + '" in this sentence:\n"' + sentence + '"\n' +
            'Give: lemma (dictionary form in ' + (LANG_LABEL[from] || from) + '), translation (meaning in this sentence, in ' + (LANG_LABEL[to] || to) + '), partOfSpeech (in ' + (LANG_LABEL[to] || to) + '), note (one short helpful tip in ' + (LANG_LABEL[to] || to) + ', e.g. verb tense or gender; may be empty).'});
      } catch (e) { if (/key/i.test(e.message)) throw e; }
    }
    return {lemma: word, translation: await translate(word, from, to, null), partOfSpeech: '', note: ''};
  }
  function googleTranslateLink(text, from, to) {
    return 'https://translate.google.com/?sl=' + from + '&tl=' + to + '&op=translate&text=' + encodeURIComponent(text.slice(0, 4000));
  }

  // ---------------- Summary ----------------
  const STOP = new Set(('the and of to a in is was that with for he she it you his her they have not this be at as on by but had from or were are which an all their there been one so what if would who out when them some into more no could my up said we me him its than then only about over also do did just'
    + ' el la los las de que y en un una es por con no se del para su sus al lo como más pero sus le ya o este sí porque esta entre cuando muy sin sobre también me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mí antes algunos qué unos yo otro otras otra él tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros mi mis tú te ti tu tus ellas nosotras vosotros vosotras os mío mía míos mías tuyo tuya tuyos tuyas suyo suya suyos suyas nuestro nuestra nuestros nuestras vuestro vuestra vuestros vuestras esos esas estoy estás está estamos estáis están era eras éramos erais eran fue fueron había'
    + ' في من على إلى عن أن إن كان كانت هذا هذه ذلك التي الذي الذين ما لا لم لن قد ثم أو و مع كل بين عند هو هي هم نحن أنا أنت فيه فيها به بها له لها منه منها'
    + ' le la les des et est une un que dans pour pas qui sur avec il elle ce du au der die das und ist nicht ein eine zu den mit sich auf für ich von dem sie es auch').split(/\s+/));
  function extractiveSummary(sentences, count) {
    const words = s => (s.toLowerCase().match(/[\p{L}\p{M}]+/gu) || []).filter(w => w.length > 2 && !STOP.has(w));
    const freq = new Map();
    for (const s of sentences) for (const w of words(s)) freq.set(w, (freq.get(w) || 0) + 1);
    const n = count || Math.max(3, Math.min(10, Math.round(sentences.length * 0.06)));
    const scored = sentences.map((s, i) => {
      const ws = words(s);
      const score = ws.reduce((a, w) => a + (freq.get(w) || 0), 0) / Math.max(4, ws.length) + (s.length < 30 ? -5 : 0);
      return {s, i, score};
    });
    return scored.sort((a, b) => b.score - a.score).slice(0, n).sort((a, b) => a.i - b.i).map(x => x.s);
  }
  async function recap(text, lang, outLang, key, scopeLabel) {
    const max = 300000;
    if (text.length > max) text = '[…]\n' + text.slice(-max);
    return gemini({key, tier: 'smart', timeout: 120000, prompt:
      'Someone is listening to a book as an audiobook and wants a recap of ' + scopeLabel + ', up to where they stopped. ' +
      'Write the recap in ' + (LANG_LABEL[outLang] || 'English') + '. Use 5 to 9 short bullet points starting with "• ": main events or ideas, key people, and where things stand now. ' +
      'Only use what is in the text below (never reveal later parts of the book). No introduction.\n\nTEXT (' + (LANG_LABEL[lang] || lang) + '):\n' + text});
  }

  // ---------------- Scan clean-up ----------------
  const pageNumberLine = /^[\s\-–—·•.()[\]]*((page|p\.|pág\.?|página|صفحة|ص)\s*)?([0-9٠-٩]{1,4}|[ivxlcdm]{1,6})[\s\-–—·•.()[\]]*$/i;
  function normLine(l) { return l.toLowerCase().replace(/[0-9٠-٩]+/g, '').replace(/[^\p{L}]+/gu, ''); }
  /** Removes page numbers, running headers/footers and garbage lines from raw page text. */
  function cleanRawPage(raw, memory) {
    if (!raw) return raw;
    let lines = raw.split(/\r?\n/).map(l => l.trim());
    lines = lines.filter(l => {
      if (!l) return true;
      if (pageNumberLine.test(l)) return false;
      const letters = (l.match(/\p{L}/gu) || []).length;
      if (l.length >= 4 && letters / l.length < 0.3 && !/^[*·•\s]+$/.test(l)) return false;
      return true;
    });
    const content = lines.map((l, i) => [l, i]).filter(([l]) => l);
    const edges = [...content.slice(0, 2), ...content.slice(-2)];
    const drop = new Set();
    const seen = [];
    for (const [l, i] of edges) {
      const n = normLine(l);
      if (l.length > 90 || n.length < 3) continue;
      if ((memory.get(n) || 0) >= 2) drop.add(i);
      seen.push(n);
    }
    for (const n of new Set(seen)) memory.set(n, (memory.get(n) || 0) + 1);
    return lines.filter((_, i) => !drop.has(i)).join('\n');
  }

  // ---------------- AI page pass: OCR fix and Arabic tashkeel ----------------
  const stripMarks = s => s.replace(/[ً-ْٰـ]/g, '');
  function similarity(a, b) {
    const grams = s => { s = s.replace(/\s+/g, ' ').slice(0, 4000); const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
    const A = grams(a), B = grams(b);
    let inter = 0, total = 0;
    for (const [g, n] of A) { inter += Math.min(n, B.get(g) || 0); total += n; }
    for (const n of B.values()) total += n;
    return total ? 2 * inter / total : 1;
  }
  async function improvePage(text, lang, {fix, tashkeel}, key, signal) {
    const jobs = [];
    if (fix) jobs.push('This text was recognized by OCR from a scanned book page, so it has recognition mistakes. Correct obvious OCR errors (wrong or broken letters, stray symbols, words wrongly split or joined), and remove running headers, page numbers and garbage. Do not rephrase, summarize, translate, or add anything.');
    if (tashkeel) jobs.push('Add full Arabic diacritics (tashkeel) to every word so it is pronounced correctly when read aloud. Do not change, add or remove any letters or words.');
    const out = await gemini({key, tier: 'smart', signal, timeout: 120000, prompt:
      jobs.join('\n') + '\nReturn only the resulting text, with no comments.\n\nTEXT (' + (LANG_LABEL[lang] || lang) + '):\n' + text});
    const clean = out.replace(/^```\w*\s*|\s*```$/g, '').trim();
    const ratio = stripMarks(clean).length / Math.max(1, stripMarks(text).length);
    const sim = similarity(stripMarks(clean), stripMarks(text));
    if (!fix && sim < 0.9) throw new Error('Vowel marks changed the words — kept the original.');
    if (fix && (ratio < 0.6 || ratio > 1.4 || sim < 0.55)) throw new Error('The AI changed this page too much — kept the original.');
    return clean;
  }

  // ---------------- Book finder ----------------
  async function getJson(url, ms = 15000) {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
    try { const r = await fetch(url, {signal: c.signal}); if (!r.ok) throw new Error(r.status); return await r.json(); }
    finally { clearTimeout(t); }
  }
  async function searchBooks(query) {
    const q = encodeURIComponent(query.trim());
    const isbn = query.replace(/[^0-9Xx]/g, '');
    const isIsbn = /^(97[89])?\d{9}[\dXx]$/.test(isbn) && isbn.length >= 10;
    const [gb, ol, gut] = await Promise.allSettled([
      getJson('https://www.googleapis.com/books/v1/volumes?maxResults=8&q=' + (isIsbn ? 'isbn:' + isbn : q)),
      getJson('https://openlibrary.org/search.json?limit=8&fields=key,title,author_name,first_publish_year,cover_i,ia,ebook_access,language&' + (isIsbn ? 'isbn=' + isbn : 'q=' + q)),
      isIsbn ? Promise.resolve({results: []}) : getJson('https://gutendex.com/books/?search=' + q)
    ]);
    const results = [];
    for (const it of gb.value?.items || []) {
      const v = it.volumeInfo || {}, a = it.accessInfo || {};
      const free = a.accessViewStatus === 'FULL_PUBLIC_DOMAIN' || a.epub?.downloadLink || a.pdf?.downloadLink;
      results.push({source: 'Google Books', title: v.title + (v.subtitle ? ': ' + v.subtitle : ''), author: (v.authors || []).join(', '),
        year: (v.publishedDate || '').slice(0, 4), lang: v.language, cover: (v.imageLinks?.thumbnail || '').replace(/^http:/, 'https:'),
        about: (v.description || '').slice(0, 260), info: v.infoLink || v.previewLink,
        download: free ? (a.epub?.downloadLink || a.pdf?.downloadLink) : null, downloadType: a.epub?.downloadLink ? 'epub' : 'pdf'});
    }
    for (const d of ol.value?.docs || []) {
      const ia = (d.ia || [])[0];
      results.push({source: 'Open Library', title: d.title, author: (d.author_name || []).slice(0, 3).join(', '), year: d.first_publish_year || '',
        cover: d.cover_i ? 'https://covers.openlibrary.org/b/id/' + d.cover_i + '-M.jpg' : '', info: 'https://openlibrary.org' + d.key,
        freePage: d.ebook_access === 'public' && ia ? 'https://archive.org/details/' + ia : null,
        download: d.ebook_access === 'public' && ia ? 'https://archive.org/download/' + ia + '/' + ia + '.pdf' : null, downloadType: 'pdf'});
    }
    for (const b of (gut.value?.results || []).slice(0, 8)) {
      const f = b.formats || {};
      const epub = f['application/epub+zip'], txt = Object.keys(f).find(k => k.startsWith('text/plain'));
      results.push({source: 'Project Gutenberg (free)', title: b.title, author: (b.authors || []).map(a => a.name).join(', '),
        lang: (b.languages || [])[0], cover: f['image/jpeg'] || '', info: 'https://www.gutenberg.org/ebooks/' + b.id,
        download: epub || (txt && f[txt]), downloadType: epub ? 'epub' : 'txt', free: true});
    }
    // Free books first, then the rest.
    return results.filter(r => r.title).sort((a, b) => (b.download ? 1 : 0) - (a.download ? 1 : 0));
  }
  async function identifyCover(imageBlob, key) {
    const data = await new Promise((resolve, reject) => {
      const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.onerror = reject; r.readAsDataURL(imageBlob);
    });
    return gemini({key, tier: 'smart', image: {data, mime: imageBlob.type || 'image/jpeg'},
      schema: {type: 'object', properties: {title: {type: 'string'}, author: {type: 'string'}, isbn: {type: 'string'}, language: {type: 'string'}}, required: ['title']},
      prompt: 'This is a photo of a book cover (front or back). Identify the book. Give its title exactly as printed, the author, the ISBN if a barcode/ISBN is visible (digits only, else empty), and the language code of the title (e.g. ar, en, es).'});
  }
  /** Shrinks a camera photo so it uploads and processes quickly. */
  async function shrinkImage(file, max = 1280) {
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      return await new Promise(r => c.toBlob(b => r(b || file), 'image/jpeg', 0.85));
    } catch { return file; }
  }
  async function readBarcode(blob) {
    if (!('BarcodeDetector' in root)) return null;
    try {
      const supported = await BarcodeDetector.getSupportedFormats();
      const formats = ['ean_13', 'upc_a'].filter(f => supported.includes(f));
      if (!formats.length) return null;
      const det = new BarcodeDetector({formats});
      const codes = await det.detect(await createImageBitmap(blob));
      const code = codes.map(c => c.rawValue).find(v => /^97[89]\d{10}$/.test(v) || /^\d{9}[\dX]$/.test(v));
      return code || null;
    } catch { return null; }
  }

  root.QariAI = {LANG_LABEL, gemini, translate, lookupWord, googleTranslateLink, extractiveSummary, recap,
    cleanRawPage, improvePage, stripMarks, similarity, searchBooks, identifyCover, shrinkImage, readBarcode};
})(typeof window !== 'undefined' ? window : globalThis);
