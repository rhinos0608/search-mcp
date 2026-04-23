const NAMED: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&#x27;': "'",
  '&#x2F;': '/',
  '&nbsp;': ' ',
};

const NAMED_RE = /&(?:amp|lt|gt|quot|apos|#39|#x27|#x2F|nbsp);/g;
const NUMERIC_RE = /&#(?:x([\da-fA-F]+)|(\d+));/g;

export function decodeHtmlEntities(text: string): string {
  let out = text.replace(NAMED_RE, (m) => NAMED[m] ?? m);
  out = out.replace(NUMERIC_RE, (_m, hex: string | undefined, dec: string | undefined) => {
    const code = hex ? parseInt(hex, 16) : parseInt(dec ?? '', 10);
    return Number.isNaN(code) ? _m : String.fromCodePoint(code);
  });
  return out;
}
