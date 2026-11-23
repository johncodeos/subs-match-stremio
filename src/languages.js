// Per-language tuning data for subtitle matching, embedded detection and decoding.
// Keys are ISO 639-1 codes and appear in the LANGUAGES setting.

const escape = (token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const raw = {
  el: {
    name: 'Greek', native: 'Ελληνικά', flag: '🇬🇷', iso6392: 'gre',
    flags: ['🇬🇷'],
    trackCodes: /^(?:gre|ell|el|gr|grek|greek)$/,
    trackName: /greek|ελληνικ/i,
    markers: ['greek', 'gre', 'ell', 'el', 'gr'],
    subsWords: 'υπ[όο]τ[ίι]τλ', dubWords: 'μεταγλ[ώω]ττιση',
    nativeSubs: 'ελληνικ\\w*[\\s.,_-]*υπ[όο]τ[ίι]τλ|υπ[όο]τ[ίι]τλ\\w*[\\s.,_-]*ελληνικ\\w*',
    subsource: 'greek', subdl: 'EL', osCodes: ['el'],
    aliases: ['el', 'gre', 'ell', 'gr', 'greek', 'ελληνικά', 'ελληνικα'],
    encoding: 'windows-1253'
  },
  en: {
    name: 'English', native: 'English', flag: '🇬🇧', iso6392: 'eng',
    flags: ['🇬🇧', '🇺🇸'],
    trackCodes: /^(?:eng|en|english)$/,
    trackName: /english/i,
    markers: ['english', 'eng', 'en'],
    subsource: 'english', subdl: 'EN', osCodes: ['en'],
    aliases: ['en', 'eng', 'english'],
    encoding: 'windows-1252'
  },
  es: {
    name: 'Spanish', native: 'Español', flag: '🇪🇸', iso6392: 'spa',
    flags: ['🇪🇸'],
    trackCodes: /^(?:spa|esp|es|spanish)$/,
    trackName: /spanish|español|espanol/i,
    markers: ['spanish', 'spa', 'esp', 'es', 'castellano'],
    subsWords: 'subtitul', dubWords: 'doblaj',
    subsource: 'spanish', subdl: 'ES', osCodes: ['es'],
    aliases: ['es', 'esp', 'spa', 'spanish', 'espanol', 'español', 'castellano'],
    encoding: 'windows-1252'
  },
  pt: {
    name: 'Portuguese', native: 'Português', flag: '🇵🇹', iso6392: 'por',
    flags: ['🇵🇹', '🇧🇷'],
    trackCodes: /^(?:por|pt|portuguese)$/,
    trackName: /portuguese|português|portugues|brazilian|brasil/i,
    markers: ['portuguese', 'portugues', 'brazilian', 'por', 'pt'],
    subsWords: 'legend', dubWords: 'dublagem',
    subsource: 'portuguese', subdl: 'PT', osCodes: ['pt', 'pt-br'],
    aliases: ['pt', 'ptbr', 'pt-br', 'br', 'pb', 'por', 'portuguese', 'portugues', 'português', 'brazilian', 'brazil'],
    encoding: 'windows-1252'
  },
  fr: {
    name: 'French', native: 'Français', flag: '🇫🇷', iso6392: 'fre',
    flags: ['🇫🇷'],
    trackCodes: /^(?:fre|fra|fr|french)$/,
    trackName: /french|français|francais/i,
    markers: ['french', 'fre', 'fra', 'fr'],
    subsWords: 'sous-tit', dubWords: 'doublage',
    subsource: 'french', subdl: 'FR', osCodes: ['fr'],
    aliases: ['fr', 'fre', 'fra', 'french', 'francais', 'français'],
    encoding: 'windows-1252'
  },
  de: {
    name: 'German', native: 'Deutsch', flag: '🇩🇪', iso6392: 'ger',
    flags: ['🇩🇪'],
    trackCodes: /^(?:deu|ger|de|german)$/,
    trackName: /german|deutsch/i,
    markers: ['german', 'deu', 'ger', 'de'],
    subsWords: 'untertit', dubWords: 'synchronfassung',
    subsource: 'german', subdl: 'DE', osCodes: ['de'],
    aliases: ['de', 'deu', 'ger', 'german', 'deutsch'],
    encoding: 'windows-1252'
  },
  it: {
    name: 'Italian', native: 'Italiano', flag: '🇮🇹', iso6392: 'ita',
    flags: ['🇮🇹'],
    trackCodes: /^(?:ita|it|italian)$/,
    trackName: /italian|italiano/i,
    markers: ['italian', 'ita', 'it'],
    subsWords: 'sottotit', dubWords: 'doppiat',
    subsource: 'italian', subdl: 'IT', osCodes: ['it'],
    aliases: ['it', 'ita', 'italian', 'italiano'],
    encoding: 'windows-1252'
  },
  pl: {
    name: 'Polish', native: 'Polski', flag: '🇵🇱', iso6392: 'pol',
    flags: ['🇵🇱'],
    trackCodes: /^(?:pol|pl|polish)$/,
    trackName: /polish|polski/i,
    markers: ['polish', 'pol', 'pl'],
    subsWords: 'napis', dubWords: 'lektor',
    subsource: 'polish', subdl: 'PL', osCodes: ['pl'],
    aliases: ['pl', 'pol', 'polish', 'polski'],
    encoding: 'windows-1250'
  },
  ru: {
    name: 'Russian', native: 'Русский', flag: '🇷🇺', iso6392: 'rus',
    flags: ['🇷🇺'],
    trackCodes: /^(?:rus|ru|russian)$/,
    trackName: /russian|русск/i,
    markers: ['russian', 'rus', 'ru'],
    subsWords: 'субтитр', dubWords: 'дубляж',
    subsource: 'russian', subdl: 'RU', osCodes: ['ru'],
    aliases: ['ru', 'rus', 'russian', 'русский'],
    encoding: 'windows-1251'
  },
  tr: {
    name: 'Turkish', native: 'Türkçe', flag: '🇹🇷', iso6392: 'tur',
    flags: ['🇹🇷'],
    trackCodes: /^(?:tur|tr|turkish)$/,
    trackName: /turkish|türk/i,
    markers: ['turkish', 'tur', 'tr'],
    subsWords: 'altyaz', dubWords: 'dublaj',
    subsource: 'turkish', subdl: 'TR', osCodes: ['tr'],
    aliases: ['tr', 'tur', 'turkish', 'turkce', 'türkçe'],
    encoding: 'windows-1254'
  },
  ar: {
    name: 'Arabic', native: 'العربية', flag: '🇸🇦', iso6392: 'ara',
    flags: ['🇸🇦', '🇦🇪'],
    trackCodes: /^(?:ara|ar|arabic)$/,
    trackName: /arabic|عرب/i,
    markers: ['arabic', 'ara', 'ar'],
    subsWords: 'ترجم', dubWords: 'مدبلج',
    subsource: 'arabic', subdl: 'AR', osCodes: ['ar'],
    aliases: ['ar', 'ara', 'arabic', 'عرب', 'العربية'],
    encoding: 'windows-1256'
  },
  ro: {
    name: 'Romanian', native: 'Română', flag: '🇷🇴', iso6392: 'rum',
    flags: ['🇷🇴'],
    trackCodes: /^(?:ron|rum|ro|romanian)$/,
    trackName: /romanian|român/i,
    markers: ['romanian', 'ron', 'rum', 'ro'],
    subsWords: 'subtitr', dubWords: 'dublat',
    subsource: 'romanian', subdl: 'RO', osCodes: ['ro'],
    aliases: ['ro', 'ron', 'rum', 'romanian', 'romana', 'română'],
    encoding: 'windows-1250'
  }
};

function build({ markers, nativeSubs, ...profile }) {
  const words = [profile.name.toLowerCase(), ...markers].map(escape).join('|');
  return {
    ...profile,
    markers,
    explicit: new RegExp(
      `\\b(?:${words})[\\s._(-]*subs?(?:titles?)?\\b|\\bsubs?[\\s._)-]*(?:${words})\\b` +
      (nativeSubs ? `|${nativeSubs}` : ''), 'i'),
    trailing: new RegExp(`(?:^|[\\s._\\-[(])(?:${markers.map(escape).join('|')})[\\s._\\-)\\]]*$`, 'i')
  };
}

export const languages = Object.fromEntries(
  Object.entries(raw).map(([code, profile]) => [code, build(profile)])
);

export const languageCodes = Object.keys(languages);

export const allMarkers = [...new Set(Object.values(languages).flatMap((profile) => profile.markers))];

export function resolveLanguages(value) {
  const parts = (Array.isArray(value) ? value : String(value ?? '').split(','))
    .map((code) => String(code).trim().toLowerCase()).filter(Boolean);
  const chosen = new Set(parts);
  for (const code of chosen) if (!languages[code]) throw new Error(`Unsupported subtitle language code: ${code}.`);
  if (!chosen.size) throw new Error('Choose at least one subtitle language.');
  return languageCodes.filter((code) => chosen.has(code));
}

export function matchLanguage(value, selected) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return null;
  const words = new Set([...text.split(/[^a-z0-9]+/i).filter(Boolean), text]);
  for (const code of selected) {
    if (languages[code].aliases.some((alias) => words.has(alias))) return code;
  }
  return null;
}

export function flagsFor(codes) {
  return [...new Set(codes)].map((code) => languages[code]?.flag ?? '').join('');
}

export function namesFor(codes) {
  return [...new Set(codes)].map((code) => languages[code]?.name ?? code).join(', ');
}
