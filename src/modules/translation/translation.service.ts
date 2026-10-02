// Translates short task-instruction strings for the campaign detail page's
// English/Hindi toggle. Done server-side rather than called directly from
// the app: browser/webview CORS rules block a client straight to either of
// these free providers (Google's unofficial endpoint sends no CORS header
// at all; MyMemory's does, but its rate-limit response often omits it too,
// which shows up client-side as an opaque "CORS error" either way). A
// server-to-server call isn't subject to CORS at all, so proxying here
// fixes that regardless of which provider actually answers.
//
// Google's endpoint (the same one "client=gtx" translate widgets use) is
// tried first since it's generally the better translation; MyMemory is the
// fallback since it's the more stable of the two - Google's has no
// published quota and returns a plain "automated queries" block once
// tripped. Neither takes an API key or costs anything.
//
// Cached in memory only: instructions text is small in variety (one string
// per task, rarely edited) and this process's memory does not need to
// survive a restart for a machine-translated convenience string.
const cache = new Map<string, string>();

async function translateWithGoogle(text: string, target: string): Promise<string | null> {
  // sl=auto rather than a hardcoded source - an agent may type the campaign
  // description in Hindi directly (see campaign-form.component.ts's preview
  // toggle), in which case this should recognize that and hand the text
  // back unchanged rather than mistranslating it as if it were English.
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as unknown;
    // Shape: [[["translated segment","source segment",null,null,...], ...], ...]
    const segments = Array.isArray(data) ? (data[0] as unknown) : null;
    if (!Array.isArray(segments)) return null;
    const translated = segments.map((seg) => (Array.isArray(seg) ? seg[0] : null)).filter((s): s is string => typeof s === 'string').join('');
    return translated.trim() || null;
  } catch {
    return null;
  }
}

async function translateWithMyMemory(text: string, target: string): Promise<string | null> {
  // "autodetect" as the source, same reasoning as Google's sl=auto above.
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=autodetect|${encodeURIComponent(target)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as { responseData?: { translatedText?: string }; responseStatus?: number | string } | null;
    const translated = data?.responseData?.translatedText;
    // MyMemory refuses same-source/target pairs with this exact message
    // instead of an error status - meaning the text was detected as already
    // being in the target language, so it's returned as-is.
    if (translated === 'PLEASE SELECT TWO DISTINCT LANGUAGES') return text;
    return translated?.trim() || null;
  } catch {
    return null;
  }
}

export async function translateText(text: string, target: string): Promise<string> {
  const cacheKey = `${target}:${text}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const translated = (await translateWithGoogle(text, target)) ?? (await translateWithMyMemory(text, target)) ?? text;
  cache.set(cacheKey, translated);
  return translated;
}
