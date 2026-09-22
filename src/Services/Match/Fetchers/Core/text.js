/**
 * HTML/metin yardimcilari.
 *
 * `decodeHtmlEntities`, `stripTags`, `parseAttributes` betist fetcher'indan
 * cikarildi; `foldName` ise spor/lig adlarini siteler arasi karsilastirmak
 * icin ortak bir normalize bicimi saglar.
 */

const NAMED_ENTITIES = {
  quot: '"',
  apos: "'",
  amp: "&",
  lt: "<",
  gt: ">",
  nbsp: " ",
};

function decodeHtmlEntities(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number(num)))
    .replace(/&(quot|apos|amp|lt|gt|nbsp);/g, (_, name) =>
      // &amp; en sonda cozulmeli, yoksa "&amp;lt;" once "&lt;" olup sonra
      // "<" olurdu. Tek gecisli replace bu sirayi zaten garanti ediyor.
      Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name)
        ? NAMED_ENTITIES[name]
        : `&${name};`
    );
}

function stripTags(value) {
  return decodeHtmlEntities(
    String(value)
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** Bir acilis etiketindeki nitelikleri sozluge cevirir. */
function parseAttributes(tag) {
  const attrs = {};

  const regex = /([:\w-]+)\s*=\s*(["'])(.*?)\2/g;

  let match;

  while ((match = regex.exec(tag)) !== null) {
    attrs[match[1].toLowerCase()] = decodeHtmlEntities(match[3]);
  }

  return attrs;
}

/**
 * Spor/kategori adlarini siteler arasi eslestirmek icin ortak bicime indirger.
 *
 * Uc site ayni sporu uc farkli sekilde yaziyor:
 *   betist "Amerikan Futbolu" / virusbet "AmericanFootball" / mavibet "Am. Football"
 *
 * Bu yuzden: camelCase ayrilir, Turkce harfler katlanir, aksanlar atilir,
 * noktalama bosluga cevrilir. Ucu de "amerikan futbolu" / "american football"
 * / "am football" bicimine iner ve catalog'daki alias listesinden eslesir.
 */
function foldName(value) {
  return String(value ?? "")
    // "AmericanFootball" -> "American Football" (aksi halde tek kelime kalirdi)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    // "Formula1" -> "Formula 1": virusbet rakami bitisik yaziyor, digerleri
    // ayirarak. Bu olmadan "Formula1" ile "Formula 1" eslesmiyordu.
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .toLowerCase()
    .replace(/ı/g, "i")
    .replace(/İ/g, "i")
    .replace(/ş/g, "s")
    .replace(/ğ/g, "g")
    .replace(/ç/g, "c")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export { decodeHtmlEntities, stripTags, parseAttributes, foldName };
