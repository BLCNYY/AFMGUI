// Dictation with Apple's own speech recognition.
//
// Safari (macOS) and every browser on iPhone/iPad run on WebKit, where the
// Web Speech API is backed by Apple's speech engine. Other desktop browsers
// (Chrome, Edge, …) send audio to their own vendor's service, so dictation is
// deliberately disabled there.

export function dictationSupport() {
  const ua = navigator.userAgent;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const isMacSafari =
    /Macintosh/.test(ua) &&
    /AppleWebKit\//.test(ua) &&
    /Safari\//.test(ua) &&
    !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS|Electron|Brave|Vivaldi|YaBrowser/i.test(ua);

  if (!isIOS && !isMacSafari) return { ok: false, reason: 'Works only on Safari' };
  if (!window.isSecureContext) {
    return { ok: false, insecure: true, reason: 'Dictation needs a secure (HTTPS) connection. Click for setup.' };
  }
  if (!SR) return { ok: false, reason: 'Works only on Safari' };
  return { ok: true, SR };
}

const ERRORS = {
  'not-allowed': 'Allow microphone and speech recognition access for this site to use dictation.',
  'service-not-allowed':
    'Speech recognition isn’t available. Make sure Dictation is turned on (System Settings › Keyboard on Mac, Settings › General › Keyboard on iPhone).',
  'audio-capture': 'No microphone was found.',
  network: 'Speech recognition needs a network connection right now.',
  'language-not-supported': 'Dictation doesn’t support your language yet.',
};

export class Dictation {
  constructor(SR, { onStart, onText, onEnd, onError }) {
    this.SR = SR;
    this.cb = { onStart, onText, onEnd, onError };
    this.rec = null;
  }

  get active() {
    return Boolean(this.rec);
  }

  start() {
    if (this.rec) return;
    const rec = new this.SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.lang = navigator.language || 'en-US';
    rec.onstart = () => this.cb.onStart?.();
    rec.onresult = (event) => this.cb.onText?.(transcriptOf(event.results));
    rec.onerror = (event) => {
      if (event.error === 'aborted') return;
      if (event.error === 'no-speech') return this.cb.onError?.('Didn’t hear anything. Try again.', true);
      this.cb.onError?.(ERRORS[event.error] || `Dictation stopped (${event.error}).`);
    };
    rec.onend = () => {
      if (this.rec === rec) this.rec = null;
      this.cb.onEnd?.();
    };
    this.rec = rec;
    try {
      rec.start();
    } catch (err) {
      this.rec = null;
      this.cb.onError?.(`Couldn’t start dictation: ${err.message}`);
      this.cb.onEnd?.();
    }
  }

  stop() {
    this.rec?.stop();
  }
}

// Builds the whole transcript (final + interim) from a results list.
// Some WebKit versions report each result as the cumulative transcript so
// far; collapse those instead of repeating words.
function transcriptOf(results) {
  const parts = [];
  for (let i = 0; i < results.length; i++) {
    const t = (results[i][0]?.transcript || '').trim();
    if (!t) continue;
    const prev = parts[parts.length - 1];
    if (prev && t.startsWith(prev)) parts[parts.length - 1] = t;
    else parts.push(t);
  }
  return parts.join(' ').replace(/\s+/g, ' ');
}
