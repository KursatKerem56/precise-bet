/**
 * HTML/text helpers.
 *
 * `decodeHtmlEntities`, `stripTags` and `parseAttributes` were extracted from
 * the betist fetcher; `foldName` provides a shared normalisation format for
 * comparing sport/league names across sites.
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
      // &amp; must be decoded last, otherwise "&amp;lt;" would first become
      // "&lt;" and then "<". A single-pass replace already guarantees that order.
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

/** Converts the attributes of an opening tag into a dictionary. */
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
 * Reduces sport/category names to a shared form so they can be matched across
 * sites.
 *
 * The three sites spell the same sport in three different ways:
 *   betist "Amerikan Futbolu" / virusbet "AmericanFootball" / mavibet "Am. Football"
 *
 * So: camelCase is split, Turkish letters are folded, accents are dropped and
 * punctuation becomes whitespace. All three collapse to "amerikan futbolu" /
 * "american football" / "am football" and match through the alias list in the
 * catalog.
 */
function foldName(value) {
  return String(value ?? "")
    // "AmericanFootball" -> "American Football" (otherwise it stays one word)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    // "Formula1" -> "Formula 1": virusbet writes the digit attached, the
    // others keep it separate. Without this "Formula1" never matched "Formula 1".
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
