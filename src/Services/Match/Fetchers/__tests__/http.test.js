/**
 * HttpClient testleri.
 *
 * Ag erisimi YOK: `https.get` gecici olarak degistirilip yanitlar taklit
 * ediliyor. Burada asil dogrulanan sey, hangi HTTP durumunun yeniden
 * denenecegi -- yanlis siniflandirma ya veri kaybettirir (429'u kalici
 * saymak) ya da siteyi gereksiz doverek rate limit'i kotulestirir
 * (403'u gecici saymak).
 */

import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { EventEmitter } from "node:events";

import { HttpClient } from "../Core/http.js";

const noop = () => undefined;

const silentLogger = { warn: noop, info: noop, error: noop, debug: noop };

function fakeResponse({ status, body = "", headers = {} }) {
  const res = new EventEmitter();

  res.statusCode = status;
  res.statusMessage = "";
  res.headers = headers;
  res.resume = noop;

  setImmediate(() => {
    res.emit("data", Buffer.from(body));
    res.emit("end");
  });

  return res;
}

/**
 * `https.get`'i test suresince degistirir.
 * @param {(call: number) => object} respond
 */
function withFakeHttp(respond, run) {
  const original = https.get;

  let calls = 0;

  https.get = (url, options, callback) => {
    calls++;

    const request = new EventEmitter();

    request.setTimeout = noop;
    request.destroy = noop;

    setImmediate(() => callback(respond(calls)));

    return request;
  };

  return Promise.resolve(run(() => calls)).finally(() => {
    https.get = original;
  });
}

test("HTTP 429: Retry-After'a uyar ve yeniden dener", async () => {
  await withFakeHttp(
    (call) =>
      call === 1
        ? fakeResponse({
            status: 429,
            body: "slow down",
            headers: { "retry-after": "0" },
          })
        : fakeResponse({ status: 200, body: "OK" }),
    async (calls) => {
      const client = new HttpClient({
        logger: silentLogger,
        retry: { attempts: 3, baseDelayMs: 1 },
      });

      const response = await client.get("https://ornek/");

      assert.equal(response.body, "OK");
      assert.equal(calls(), 2, "tam bir kez yeniden denenmeli");
      assert.equal(client.stats.retries, 1);
    }
  );
});

test("HTTP 403: KALICI, yeniden denenmez", async () => {
  await withFakeHttp(
    () => fakeResponse({ status: 403, body: "forbidden" }),
    async (calls) => {
      const client = new HttpClient({
        logger: silentLogger,
        retry: { attempts: 3, baseDelayMs: 1 },
      });

      await assert.rejects(client.get("https://ornek/"), (error) => {
        assert.equal(error.statusCode, 403);
        assert.equal(error.retryable, false);
        return true;
      });

      // 403'u yeniden denemek siteyi dovmekten baska ise yaramaz.
      assert.equal(calls(), 1);
    }
  );
});

test("HTTP 503: gecici, hak bitene kadar denenir", async () => {
  await withFakeHttp(
    () => fakeResponse({ status: 503, body: "busy" }),
    async (calls) => {
      const client = new HttpClient({
        logger: silentLogger,
        retry: { attempts: 3, baseDelayMs: 1 },
      });

      await assert.rejects(client.get("https://ornek/"), /503/);

      assert.equal(calls(), 3);
    }
  );
});

test("beklenenden buyuk govde kesilir (OOM korumasi)", async () => {
  await withFakeHttp(
    () => fakeResponse({ status: 200, body: "x".repeat(5000) }),
    async () => {
      const client = new HttpClient({
        logger: silentLogger,
        maxBodyBytes: 100,
        retry: { attempts: 1 },
      });

      await assert.rejects(client.get("https://ornek/"), /cok buyuk/);
    }
  );
});

test("cookie jar Set-Cookie basliklarini biriktirir", async () => {
  await withFakeHttp(
    () =>
      fakeResponse({
        status: 200,
        body: "OK",
        headers: { "set-cookie": ["a=1; Path=/; HttpOnly", "b=2"] },
      }),
    async () => {
      const client = new HttpClient({ logger: silentLogger });

      await client.get("https://ornek/");

      // Nitelikler (Path, HttpOnly) atilir, yalnizca ad=deger kalir.
      assert.equal(client.cookieHeader(), "a=1; b=2");
    }
  );
});

test("redirect takip edilir, sonsuz donguye girmez", async () => {
  await withFakeHttp(
    (call) =>
      call <= 2
        ? fakeResponse({
            status: 302,
            headers: { location: `https://ornek/${call}` },
          })
        : fakeResponse({ status: 200, body: "HEDEF" }),
    async (calls) => {
      const client = new HttpClient({ logger: silentLogger });

      assert.equal((await client.get("https://ornek/")).body, "HEDEF");
      assert.equal(calls(), 3);
    }
  );

  await withFakeHttp(
    () =>
      fakeResponse({ status: 302, headers: { location: "https://ornek/dongu" } }),
    async () => {
      const client = new HttpClient({
        logger: silentLogger,
        maxRedirects: 3,
        retry: { attempts: 1 },
      });

      await assert.rejects(client.get("https://ornek/"), /redirect/);
    }
  );
});

test("keep-alive agent kullaniliyor (TLS el sikismasi tekrarlanmasin)", () => {
  const client = new HttpClient();

  assert.equal(client.agent.keepAlive, true);
  assert.ok(client.agent.maxSockets > 0);

  client.close();
});
