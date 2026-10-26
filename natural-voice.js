/* Natural audiobook narration. Audio and book passages are cached only in memory. */
(function (root) {
  'use strict';
  class NaturalVoice {
    constructor() { this.cache = new Map(); this.pending = new Map(); this.epoch = 0; }
    cancelPending() {
      this.epoch++;
      for (const item of this.pending.values()) item.controller.abort();
      this.pending.clear();
    }
    clear() {
      this.cancelPending();
      this.cache.clear();
    }
    // Builds one passage. When `canRead` is given, the passage may continue onto the
    // next page, so a sentence broken by a page turn is narrated in one breath.
    static wav(pcm, rate) {
      const out = new Uint8Array(44 + pcm.length), v = new DataView(out.buffer);
      const w = (o, s) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
      w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length, true); w(8, 'WAVEfmt ');
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      w(36, 'data'); v.setUint32(40, pcm.length, true); out.set(pcm, 44);
      return out;
    }
    static passage(sentences, start, limit = 1100, canRead = null) {
      let end = start, text = '';
      const page = sentences[start]?.pageNum;
      while (end < sentences.length && (canRead ? canRead(sentences[end]) : sentences[end].pageNum === page)) {
        const next = sentences[end].text;
        if (text && text.length + next.length > limit) break;
        text += (text ? ' ' : '') + next;
        end++;
      }
      return {start, end, text};
    }
    async generate(text, key, voice, language) {
      if (!key) throw new Error('Add your Gemini key in Natural voice settings first.');
      const cacheKey = JSON.stringify([voice, language, text]);
      if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
      if (this.pending.has(cacheKey)) return this.pending.get(cacheKey).promise;
      const controller = new AbortController();
      const epoch = this.epoch;
      const task = {controller};
      task.promise = (async () => {
        const timer = setTimeout(() => controller.abort(), 90000);
        try {
          const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
            method: 'POST', signal: controller.signal,
            headers: {'Content-Type': 'application/json', 'x-goog-api-key': key},
            body: JSON.stringify({
              model: 'gemini-3.8-flash-tts', store: false,
              input: [{type: 'user_input', content: [{type: 'text', text,
                // Short, identical style for every passage: Google's guidance is that long
                // style blocks and meta-instructions cause voice drift between passages.
                annotations: [{type: 'speech_metadata', style:
                  'Warm, unhurried audiobook storytelling in ' + language + ', with natural pauses.'}]
              }]}],
              response_format: {type: 'audio', mime_type: 'audio/wav'},
              generation_config: {speech_config: [{voice}]}
            })
          });
          if (!response.ok) {
            // Keep Google's own reason, so problems can be told apart.
            const body = await response.json().catch(() => null);
            const reason = (body?.error?.message || '').slice(0, 160);
            const fail = (msg, kind) => { const e = new Error(msg + (reason ? ' — Google: ' + reason : '')); e.kind = kind; e.status = response.status; throw e; };
            if (response.status === 429) {
              // Google says how long to wait, e.g. "retry in 18h28m7s".
              const m = /retry in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/i.exec(reason) || [];
              const wait = ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000;
              const e = new Error(/per day/i.test(reason) ? 'The free Natural voice is used up for today.' : 'Natural voice free limit reached for now.');
              e.kind = 'limit'; e.retryMs = wait || 120000; e.status = 429; throw e;
            }
            if (response.status === 401 || response.status === 403 || /api key|api_key|permission|billing/i.test(reason)) fail('Check your Gemini key in Voice settings.', 'key');
            if (response.status === 404) fail('Natural voice is unavailable for this Gemini key.', 'key');
            if (response.status === 400) fail('Google could not voice this passage.', 'passage');
            fail('Natural voice could not be generated.', 'server');
          }
          const data = await response.json();
          const audio = (data.steps || []).filter(s => s.type === 'model_output')
            .flatMap(s => s.content || []).filter(c => c.type === 'audio' && c.data).pop();
          if (!audio) { const e = new Error('Google returned no audio for this passage.'); e.kind = 'passage'; throw e; }
          let bytes = Uint8Array.from(atob(audio.data), c => c.charCodeAt(0));
          // Raw 24 kHz 16-bit mono PCM (no header): wrap it so the phone can play it.
          if (String.fromCharCode(...bytes.slice(0, 4)) !== 'RIFF') bytes = NaturalVoice.wav(bytes, 24000);
          const blob = new Blob([bytes], {type: 'audio/wav'});
          if (epoch !== this.epoch) throw new DOMException('Cancelled', 'AbortError');
          this.cache.set(cacheKey, blob);
          // Bound memory usage, including long Arabic passages.
          let size = [...this.cache.values()].reduce((n, b) => n + b.size, 0);
          while (this.cache.size > 6 || (size > 24 * 1024 * 1024 && this.cache.size > 1)) {
            const oldest = this.cache.keys().next().value;
            size -= this.cache.get(oldest).size;
            this.cache.delete(oldest);
          }
          return blob;
        } catch (error) {
          if (error.name === 'AbortError' && epoch === this.epoch) throw new Error('Voice generation timed out. Check your connection and retry.');
          if (error instanceof TypeError) throw new Error('Could not connect to Gemini. Check your internet connection and retry.');
          throw error;
        } finally {
          clearTimeout(timer);
          if (this.pending.get(cacheKey) === task) this.pending.delete(cacheKey);
        }
      })();
      this.pending.set(cacheKey, task);
      return task.promise;
    }
  }
  root.QariNaturalVoice = NaturalVoice;
})(typeof window !== 'undefined' ? window : globalThis);
