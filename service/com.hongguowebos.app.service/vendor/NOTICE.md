# Third-party source

## `hongguo.cjs`

An **unmodified** copy of `spider/js/红果果[短].js` from the `drpys` project:

- Upstream: https://github.com/woshishiq1/drpys
- Pinned commit: `22261adfa31435e3b3ef5a730b8a2a75bcaf1715`
- Retrieved: 2026-09-21
- Upstream license: **GPL-3.0** — see `LICENSE.GPL-3.0` in this directory
- MD5 of the vendored file: `7796a8e3256478fab97b89553583b747`

The file is loaded **only** by the webOS JS service at runtime; it is never
bundled into the TV web app. The original header and inline comments were
preserved. It is loaded inside a `vm` context whose only capability is a
whitelisted `crypto` module, `Buffer`, `URL`/`URLSearchParams` and an
axios-shaped HTTP client (`../http-client.js`).

Because the source is evaluated rather than `require`d, this package does not
depend on it at install time. Redistributing a build of this app therefore
redistributes GPL-3.0 code; the whole service directory is provided under
GPL-3.0.

## Provenance chain

    woshishiq1/drpys           GPL-3.0   upstream spider
            |
            v
    N3urda/hongguoTV           GPL-3.0   vendored, adapted into a Node service
            |
            v
    this project               GPL-3.0   re-vendored, wrapped for webOS

## Runtime shims (original project code, not third-party)

| File | Purpose |
| --- | --- |
| `sm3.js` | Pure-JS SM3 (GB/T 32905-2016). Needed because webOS 6 runs Node 16, whose OpenSSL exposes SM3 but `node:crypto` does not register the digest. Verified byte-identical to OpenSSL. |
| `crypto-shim.js` | Feature-detects SM3 and patches `crypto.createHash` to fall back to `sm3.js` only when native SM3 is absent. |
| `http-client.js` | Minimal axios-compatible client over Node `http`/`https`, so the vendored source runs without shipping axios in the .ipk. |
| `compat.js` | webOS runtime shims (URL, Buffer, String extras, CA bundle). |
