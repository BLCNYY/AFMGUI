// Talking to fm serve (through the same-origin server).

export class ApiError extends Error {
  constructor(message, { status = 0, type = '', kind = 'server' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.type = type;
    this.kind = kind;
  }
}

function classify(status, type, message) {
  const m = String(message || '').toLowerCase();
  if (type === 'fm_unreachable') return 'fm_unreachable';
  if (m.includes('context size') || m.includes('context window') || m.includes('too many tokens')) return 'context';
  if (m.includes('guardrail')) return 'guardrail';
  if (status === 403) return 'forbidden';
  if (status === 429 || m.includes('rate limit') || m.includes('quota')) return 'rate';
  if (status === 503 || m.includes('unavailable')) return 'unavailable';
  return 'server';
}

export async function fetchHealth() {
  try {
    const res = await fetch('/health', { cache: 'no-store' });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      return {
        ok: false,
        kind: body?.error?.type === 'fm_unreachable' ? 'fm_unreachable' : 'server',
        message: body?.error?.message || `HTTP ${res.status}`,
      };
    }
    return { ok: true, models: Array.isArray(body?.models) ? body.models : [] };
  } catch {
    return { ok: false, kind: 'network' };
  }
}

export async function fetchAppInfo() {
  try {
    const res = await fetch('/_app/info', { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// Streams a chat completion. Calls onDelta(text) for every piece of text.
// `options` are extra request fields fm serve understands, such as
// max_completion_tokens and reasoning_effort.
// Optional web lookup: asks the local server to search Wikipedia.
export async function lookup(q, lang, signal) {
  const res = await fetch('/_app/lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q, lang }),
    signal,
  });
  if (!res.ok) throw new Error(`Lookup failed (${res.status})`);
  const body = await res.json();
  return Array.isArray(body?.results) ? body.results : [];
}

export async function streamChat({ model, messages, signal, onDelta, options }) {
  let res;
  try {
    res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ model, messages, stream: true, ...options }),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError('Network error', { kind: 'network' });
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const e = body?.error || {};
    const message = e.message || `HTTP ${res.status}`;
    throw new ApiError(message, { status: res.status, type: e.type, kind: classify(res.status, e.type, message) });
  }

  // Normally SSE, but accept a plain JSON completion too.
  if (String(res.headers.get('content-type')).includes('application/json')) {
    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content;
    if (text) onDelta(text);
    return { finishReason: body?.choices?.[0]?.finish_reason || 'stop' };
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let finishReason = null;
  try {
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        throw new ApiError('The connection was interrupted.', { kind: 'network' });
      }
      if (chunk.done) break;
      buffer += chunk.value;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') return { finishReason };
        let obj;
        try {
          obj = JSON.parse(data);
        } catch {
          continue;
        }
        if (obj.error) {
          const message = obj.error.message || 'The model stopped with an error.';
          throw new ApiError(message, { status: 500, type: obj.error.type, kind: classify(500, obj.error.type, message) });
        }
        const choice = obj.choices?.[0];
        const text = choice?.delta?.content ?? choice?.message?.content;
        if (text) onDelta(text);
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  return { finishReason };
}
