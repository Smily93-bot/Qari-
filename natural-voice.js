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
            if (response.status === 429) throw new Error('Gemini usage limit reached. Wait a little and retry, or choose Device voice.');
            if ([400, 401, 403].includes(response.status)) throw new Error('Check your Gemini key and its access to speech generation in Google AI Studio.');
            if (response.status === 404) throw new Error('Natural voice is unavailable for this Gemini project. Check speech model access in Google AI Studio.');
            throw new Error('Natural voice could not be generated. Please retry.');
          }
          const data = await response.json();
          const audio = (data.steps || []).filter(s => s.type === 'model_output')
            .flatMap(s => s.content || []).filter(c => c.type === 'audio' && c.data).pop();
          if (!audio) throw new Error('Gemini returned no audio. Please retry this passage.');
          const bytes = Uint8Array.from(atob(audio.data), c => c.charCodeAt(0));
          if (String.fromCharCode(...bytes.slice(0, 4)) !== 'RIFF') throw new Error('The voice returned an unsupported audio format. Please retry.');
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
