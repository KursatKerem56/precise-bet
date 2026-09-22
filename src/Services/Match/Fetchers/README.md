# Maç Fetcher'ları

Üç bahis sitesinden maç listesi çeker ve hepsini **aynı** JSON şekline indirger:

```json
{
  "FUTBOL": {
    "Türkiye - Süper Lig": {
      "2026-09-18": [
        { "eventId": "…", "leagueId": "…", "home": "…", "away": "…", "time": "20:00" }
      ]
    }
  },
  "BASKETBOL": { }, "VOLEYBOL": { }, "TENIS": { }
}
```

`FUTBOL`, `BASKETBOL`, `VOLEYBOL`, `TENIS` anahtarları **boş olsalar bile her zaman
bulunur** — mevcut tüketiciler (`compare-match-times.js`, `Match.service.ts`, panel
arayüzü) bunların varlığına güveniyor. Yeni sporlar bunların *ardına* eklenir.

## Dizin yapısı

```
Core/        siteden bağımsız altyapı
  http.js      keep-alive havuzlu HTTPS + cookie jar + retry + boyut sınırı
  ws.js        RFC 6455 WebSocket (+ opsiyonel permessage-deflate)
  async.js     kontrollü concurrency, exponential backoff, rate limiter
  output.js    ortak çıktı modeli (tekilleştirme + sıralama)
  runner.js    fetcher kabuğu (dosyaya yazma, özet, boş sonuç koruması)
  time.js      üç farklı zaman biriminden Türkiye saatine
  text.js      HTML entity / etiket / nitelik ayrıştırma, ad normalizasyonu
Sports/
  catalog.js   TEK spor mapping kaynağı
*-match-fetcher.js   siteye özgü protokol ve ayrıştırma
__tests__/           fixture tabanlı testler (ağ erişimi yok)
```

Siteye özgü davranış bilerek fetcher dosyalarında bırakıldı; `Core/` yalnızca
gerçekten üçünde de aynı olan işi barındırıyor.

## Protokoller

| Site | Taşıma | Spor keşfi |
|---|---|---|
| **BETIST** | HTTPS + HTML kazıma | `home.php` menüsü (zaten çekilen istek) |
| **VIRUS_BET** | WebSocket, BetConstruct "swarm" JSON | tek spor/lig ağacı sorgusu |
| **MAVI_BET** | WebSocket, WAMP v2 + deflate | `disciplinesV2` dökümü (oturum hazırlığında zaten çekiliyor) |

Üçünde de spor id'leri **koda gömülü değil**; site ne bildiriyorsa o kullanılıyor.

## Yeni bir spor eklemek

Tek adım: [`Sports/catalog.js`](./Sports/catalog.js) içindeki `SPORTS` dizisine bir
satır ekleyin.

```js
{
  key: "SNOOKER",        // çıktı JSON'undaki anahtar
  id: "SNOOKER",         // uygulama içi normalized değer
  aliases: ["snooker", "bilardo"],   // sitelerin kullandığı adlar
},
```

Sonra `Constants/Match.ts` içindeki `EMatchSport` enum'una **aynı** `id` değerini
ekleyin. (İkisinin sapmasını `catalog.test.js` yakalar, unutursanız test kırılır.)

Fetcher dosyalarına **dokunmanız gerekmez** — üçü de spor listesini siteden
okuyup katalogla eşleştiriyor.

### Alias yazarken

Adlar `foldName()` ile normalize edilip karşılaştırılıyor: camelCase ayrılır,
harf/rakam sınırı ayrılır, Türkçe karakterler katlanır, noktalama boşluğa
dönüşür. Yani tek bir alias birden çok yazımı karşılar:

| Sitenin yazdığı | foldName sonucu |
|---|---|
| `AmericanFootball` | `american football` |
| `Am. Football` | `am football` |
| `Formula1` | `formula 1` |
| `Santranç` | `santranc` |

`key` ve `id` de otomatik olarak alias sayılır.

### Eklemeden önce

Sporun sitede **gerçekten** olduğunu doğrulayın. Katalogda karşılığı olmayan bir
spor sessizce atlanır ve `MATCH_FETCHER_LOG_LEVEL=debug` ile tek satırda listelenir:

```
[VIRUS_BET] katalogda olmayan spor atlandi: Counter-Strike 2, Politics, …
```

Bu listede görmediğiniz bir sporu eklemeyin — o site onu sunmuyordur.

## Ortam değişkenleri

Hepsi isteğe bağlı.

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `MATCH_SPORTS` | *(hepsi)* | Virgüllü liste; key veya id kabul eder. Eski davranış: `FUTBOL,BASKETBOL,VOLEYBOL,TENIS` |
| `MATCH_FETCHER_LOG_LEVEL` | `info` | `silent` / `error` / `warn` / `info` / `debug` |
| `BETIST_LOG_LEVEL` vb. | — | Tek site için seviye ezme |
| `MATCH_FETCH_INTERVAL_MS` | `120000` | Turlar arası bekleme |
| `{SITE}_CONCURRENCY` | 3 / 3 / 2 | Eş zamanlı istek sınırı |
| `{SITE}_REQUEST_DELAY_MS` | 150 / 120 / 80 | İstekler arası asgari aralık |
| `{SITE}_RETRY_ATTEMPTS` | 3 | Deneme sayısı |
| `MAVIBET_BULK_TIMEOUT_MS` | `120000` | Toplu spor dökümü zaman aşımı |

Concurrency ve delay birlikte çalışır: ilki "aynı anda kaç istek", ikincisi
"saniyede kaç istek". İkisini de yükseltmek anti-bot tetikleyebilir.

## Test

```bash
npm test
```

Testler ağa çıkmaz; fixture'lar gerçek yanıtlardan kısaltılmıştır.
