import { type NextRequest, NextResponse } from "next/server"
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

// DNS lookups need the Node.js runtime (not Edge)
export const runtime = "nodejs"

const PROXY_PATH = "/api/proxy?url="
const MAX_REDIRECTS = 10
const TIMEOUT_MS = 30000
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

// Regex patterns built via RegExp constructor to prevent bundler escaping issues.
// Only static import/export specifiers with a relative or root path are rewritten; bare
// specifiers ("react") and absolute URLs are left alone.
const IMPORT_FROM_RE = new RegExp(
  '(\\b(?:(?:import|export)\\b[^;\'"`()]*?\\bfrom|import)\\s*)([\'"`])(\\.{0,2}/[^\'"`]*)\\2',
  "g"
)
const CSS_IMPORT_RE = new RegExp(
  '@import\\s+(?:url[(]\\s*)?([\'"]?)([^\'"()\\s;]+)\\1\\s*[)]?',
  "g"
)
const CSS_URL_RE = new RegExp('url[(]\\s*([\'"]?)([^\'"()]+?)\\1\\s*[)]', "g")

class BlockedUrlError extends Error {}

// ---------------------------------------------------------------------------
// SSRF protection
// ---------------------------------------------------------------------------

function isPrivateIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number)
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true
  const [a, b, c] = p
  return (
    a === 0 || // "this" network, incl. 0.0.0.0
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast + reserved
  )
}

function isPrivateIPv6(ip: string): boolean {
  const s = ip.toLowerCase()
  if (s === "::" || s === "::1") return true

  // IPv4-mapped addresses, dotted (::ffff:127.0.0.1) or hex (::ffff:7f00:1)
  const dotted = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) return isPrivateIPv4(dotted[1])
  const hex = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hex) {
    const hi = parseInt(hex[1], 16)
    const lo = parseInt(hex[2], 16)
    return isPrivateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
  }

  return (
    /^f[cd]/.test(s) || // unique local fc00::/7
    /^fe[89ab]/.test(s) || // link-local fe80::/10
    s.startsWith("ff") || // multicast
    s.startsWith("64:ff9b:") // NAT64 can reach IPv4 internals
  )
}

function isPrivateAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return isPrivateIPv4(address)
  if (family === 6) return isPrivateIPv6(address)
  return true
}

/**
 * Throws BlockedUrlError unless the URL is http(s) and every address its host
 * resolves to is public. The WHATWG URL parser already normalizes numeric
 * forms like http://2130706433 to 127.0.0.1, and resolving DNS catches
 * domains that point at private addresses.
 */
async function assertSafeUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError("Only http and https URLs are supported")
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")

  if (host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal") {
    throw new BlockedUrlError("Target URL is blocked for security reasons")
  }

  let addresses: string[]
  if (isIP(host)) {
    addresses = [host]
  } else {
    try {
      addresses = (await lookup(host, { all: true, verbatim: true })).map((a) => a.address)
    } catch {
      throw new Error(`Could not resolve host: ${host}`)
    }
  }

  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new BlockedUrlError("Target URL is blocked for security reasons")
  }
}

/**
 * Follows redirects manually so every hop is checked by assertSafeUrl.
 * (With redirect: "follow", a public URL could redirect to an internal one.)
 */
interface UpstreamInit {
  method: string
  body?: string | ArrayBuffer
  contentType?: string
  /** Extra request headers forwarded from the page (raw mode) */
  headers?: Record<string, string>
}

async function fetchUpstream(
  startUrl: string,
  init: UpstreamInit,
  signal: AbortSignal,
): Promise<{ response: Response; finalUrl: string }> {
  let current = new URL(startUrl)
  let method = init.method.toUpperCase()
  let body = init.body

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeUrl(current)

    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      DNT: "1",
      "Upgrade-Insecure-Requests": "1",
      ...init.headers,
    }
    if (body !== undefined && init.contentType) headers["Content-Type"] = init.contentType

    const response = await fetch(current, { method, headers, body, redirect: "manual", signal })

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location")
      if (!location) return { response, finalUrl: current.href }
      await response.body?.cancel().catch(() => {})
      current = new URL(location, current)
      // Browsers switch to GET after 303, and after 301/302 for POST
      if (
        (response.status === 303 && method !== "HEAD") ||
        (method === "POST" && (response.status === 301 || response.status === 302))
      ) {
        method = "GET"
        body = undefined
      }
      continue
    }

    return { response, finalUrl: current.href }
  }

  throw new Error("Too many redirects")
}

// ---------------------------------------------------------------------------
// Content rewriting
// ---------------------------------------------------------------------------

function isSkippableRef(ref: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref.trim())
}

function proxied(proxyOrigin: string, absoluteUrl: string): string {
  return `${proxyOrigin}${PROXY_PATH}${encodeURIComponent(absoluteUrl)}`
}

function processJavaScript(content: string, baseUrl: string, proxyOrigin: string): string {
  return content.replace(IMPORT_FROM_RE, (match, prefix: string, quote: string, modulePath: string) => {
    try {
      return `${prefix}${quote}${proxied(proxyOrigin, new URL(modulePath, baseUrl).href)}${quote}`
    } catch {
      return match
    }
  })
}

function processCSS(content: string, baseUrl: string, proxyOrigin: string): string {
  content = content.replace(CSS_IMPORT_RE, (match, _q: string, cssPath: string) => {
    if (isSkippableRef(cssPath)) return match
    try {
      return `@import url("${proxied(proxyOrigin, new URL(cssPath, baseUrl).href)}")`
    } catch {
      return match
    }
  })

  return content.replace(CSS_URL_RE, (match, _q: string, resourcePath: string) => {
    // Skips data:, http(s):, protocol-relative and url(#fragment) references
    if (isSkippableRef(resourcePath) || resourcePath.startsWith(proxyOrigin)) return match
    try {
      return `url("${proxied(proxyOrigin, new URL(resourcePath, baseUrl).href)}")`
    } catch {
      return match
    }
  })
}

/** Safely embeds a string inside an inline <script>. */
function jsString(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")
}

function buildInjectedScript(pageUrl: string, proxyOrigin: string): string {
  return `<script>
(function () {
  var PAGE_URL = ${jsString(pageUrl)};
  var PROXY_ORIGIN = ${jsString(proxyOrigin)};
  var TARGET_ORIGIN = new URL(PAGE_URL).origin;
  var MARK = ${jsString(PROXY_PATH)};
  window.__devonProxied = true; // lets the app tell our pages from ones that escaped the proxy

  // Paths on the proxy origin that really belong to the app, not the proxied site
  var APP_PATH = new RegExp('^/(api/proxy|_next/)');

  // Turns an href/action/URL (possibly already proxied) into the real target URL.
  // The document lives on the proxy origin, so absolute URLs built from
  // location.origin/href point at the proxy; those are mapped back to the site.
  function realUrl(ref) {
    if (ref === undefined || ref === null) return null;
    ref = String(ref);
    var i = ref.indexOf(MARK);
    if (i !== -1) {
      try { return decodeURIComponent(ref.slice(i + MARK.length).split('&')[0]); } catch (e) { return null; }
    }
    var abs;
    try { abs = new URL(ref, PAGE_URL); } catch (e) { return null; }
    if (abs.origin === PROXY_ORIGIN && !APP_PATH.test(abs.pathname)) {
      return TARGET_ORIGIN + abs.pathname + abs.search + abs.hash;
    }
    return abs.href;
  }

  // The same URL as seen from inside the frame: proxy origin + the real path,
  // so location.pathname/search/hash match the real site
  function frameUrl(url) {
    var u = new URL(url);
    return u.origin === TARGET_ORIGIN ? PROXY_ORIGIN + u.pathname + u.search + u.hash : null;
  }

  function isHttp(url) { return !!url && /^https?:/i.test(url); }

  var nativePushState = history.pushState;
  var nativeReplaceState = history.replaceState;

  // The app writes this page into a same-origin frame, so the document's URL
  // is on the proxy origin and can be rewritten to carry the real path before
  // any of the site's own scripts run.
  try {
    var initial = frameUrl(PAGE_URL);
    if (initial && location.protocol !== 'about:') nativeReplaceState.call(history, history.state, '', initial);
  } catch (e) {}

  function post(type, msg) {
    msg.type = type;
    window.parent.postMessage(msg, '*');
  }
  function send(msg) { post('proxy-navigate', msg); }

  function samePage(url) {
    var hashAt = url.indexOf('#');
    return hashAt !== -1 && url.slice(0, hashAt) === PAGE_URL.split('#')[0];
  }

  function scrollToFragment(hash) {
    var id = '';
    try { id = decodeURIComponent(hash.replace(/^#/, '')); } catch (e) { id = hash.replace(/^#/, ''); }
    if (!id || id === 'top') { window.scrollTo(0, 0); return; }
    var el = document.getElementById(id) || document.getElementsByName(id)[0];
    if (el) el.scrollIntoView();
  }

  // ---- Link clicks (also handles new-tab intent, which the Navigation API can't see)
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!el) return;
    var raw = (el.getAttribute('href') || '').trim();
    var lower = raw.toLowerCase();
    if (!raw || lower.indexOf('javascript:') === 0 || lower.indexOf('mailto:') === 0 || lower.indexOf('tel:') === 0) return;

    // Same-page anchors: scroll instead of letting <base> send the frame to the real site
    if (raw.charAt(0) === '#') { e.preventDefault(); scrollToFragment(raw); return; }

    var url = realUrl(raw);
    if (!isHttp(url)) return;
    if (samePage(url)) { e.preventDefault(); scrollToFragment(url.slice(url.indexOf('#'))); return; }

    e.preventDefault();
    var newTab = e.ctrlKey || e.metaKey || (el.getAttribute('target') || '').toLowerCase() === '_blank';
    send({ url: url, newTab: newTab });
  }, true);

  // ---- Forms
  function handleForm(form, submitter) {
    var method = ((submitter && submitter.getAttribute('formmethod')) || form.getAttribute('method') || 'get').toLowerCase();
    if (method === 'dialog') return false;
    var actionAttr = (submitter && submitter.getAttribute('formaction')) || form.getAttribute('action') || '';
    var action = actionAttr ? realUrl(actionAttr) : PAGE_URL;
    if (!isHttp(action)) return false;

    var fd;
    try { fd = submitter ? new FormData(form, submitter) : new FormData(form); } catch (err) { fd = new FormData(form); }
    var params = new URLSearchParams();
    fd.forEach(function (v, k) { if (typeof v === 'string') params.append(k, v); });
    var newTab = (form.getAttribute('target') || '').toLowerCase() === '_blank';

    if (method === 'post') {
      send({ url: action, method: 'POST', body: params.toString(), newTab: newTab });
    } else {
      var u = new URL(action);
      u.hash = '';
      u.search = params.toString(); // GET forms replace the action's query string, like browsers do
      send({ url: u.href, newTab: newTab });
    }
    return true;
  }

  // Bubble phase so a site's own handlers (AJAX forms) get to preventDefault first
  document.addEventListener('submit', function (e) {
    if (e.defaultPrevented) return;
    var form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    if (handleForm(form, e.submitter || null)) e.preventDefault();
  });

  // form.submit() skips the submit event, so route it through the proxy too
  var nativeSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () {
    if (!handleForm(this, null)) nativeSubmit.call(this);
  };

  // ---- Script-driven navigation: location.href = ..., location.assign/replace(),
  // location.reload(), meta refresh, etc. The Navigation API sees all of them and
  // lets us cancel the frame's own navigation and hand it to the app instead.
  if (window.navigation && typeof window.navigation.addEventListener === 'function') {
    window.navigation.addEventListener('navigate', function (e) {
      if (!e.cancelable || e.navigationType === 'traverse') return;
      var dest = e.destination && e.destination.url;
      if (!dest) return;

      // location.reload(): the frame's URL isn't a real page on the proxy, so let the app reload
      if (e.navigationType === 'reload') {
        e.preventDefault();
        send({ reload: true });
        return;
      }

      if (/^(about|blob|data|javascript):/i.test(dest)) return;

      // location.hash = ...: a same-document navigation, fine to let it happen natively
      if (e.hashChange && !e.formData) {
        var hashed = realUrl(dest);
        if (isHttp(hashed)) post('proxy-url-change', { url: hashed, replace: false });
        return;
      }

      // pushState/replaceState (already reported by the patched history methods)
      // and other same-document changes stay in the page
      if (e.destination.sameDocument) return;

      var url = realUrl(dest);
      if (!isHttp(url)) return;
      e.preventDefault();

      if (samePage(url)) { scrollToFragment(url.slice(url.indexOf('#'))); return; }

      // formData is only present for POST form submissions
      if (e.formData) {
        var params = new URLSearchParams();
        e.formData.forEach(function (v, k) { if (typeof v === 'string') params.append(k, v); });
        send({ url: url, method: 'POST', body: params.toString() });
      } else {
        send({ url: url, replace: e.navigationType === 'replace' });
      }
    });
  }

  // ---- window.open(): open proxied pages in a new Devon tab
  var nativeOpen = window.open;
  window.open = function (u, target) {
    var url = u === undefined || u === '' ? null : realUrl(u);
    if (!isHttp(url)) return nativeOpen.apply(window, arguments);
    var t = String(target || '_blank').toLowerCase();
    send({ url: url, newTab: t !== '_self' && t !== '_parent' && t !== '_top' });
    return null; // same as a blocked popup
  };

  // ---- history.pushState/replaceState: the site passes URLs on its own origin, which
  // <base> resolves cross-origin (SecurityError). Translate them to the same path on
  // the proxy origin, so the frame's location keeps matching the real site.
  function trackUrl(url, replace) {
    PAGE_URL = url;
    var base = document.querySelector('base');
    if (base) base.setAttribute('href', url);
    post('proxy-url-change', { url: url, replace: replace });
  }

  [['pushState', nativePushState], ['replaceState', nativeReplaceState]].forEach(function (pair) {
    var name = pair[0], native = pair[1];
    if (typeof native !== 'function') return;
    history[name] = function (state, title, u) {
      if (u === undefined || u === null) return native.apply(history, arguments);
      var url = realUrl(u);
      if (!isHttp(url)) return native.apply(history, arguments);
      var inFrame = frameUrl(url);
      trackUrl(url, name === 'replaceState');
      // A different origin can't be represented in the frame's URL; keep the state only
      return inFrame ? native.call(history, state, title, inFrame) : native.call(history, state, title);
    };
  });

  // Back/forward between the page's own pushState entries
  window.addEventListener('popstate', function () {
    var url = realUrl(location.href);
    if (isHttp(url) && url !== PAGE_URL) trackUrl(url, true);
  });

  // ---- fetch() / XMLHttpRequest: route the page's own requests through the proxy
  // (raw mode: method, body and headers forwarded; responses not rewritten)
  function toProxy(u) {
    var url = realUrl(u);
    if (!isHttp(url) || url.indexOf(PROXY_ORIGIN + '/') === 0) return null;
    return PROXY_ORIGIN + MARK + encodeURIComponent(url) + '&raw=1';
  }

  var nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      try {
        var isRequest = typeof Request !== 'undefined' && input instanceof Request;
        var target = toProxy(isRequest ? input.url : input);
        if (target) input = isRequest ? new Request(target, input) : target;
      } catch (e) {}
      return nativeFetch.call(this, input, init);
    };
  }

  var nativeXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, u) {
    var args = Array.prototype.slice.call(arguments);
    try {
      var target = toProxy(u);
      if (target) args[1] = target;
    } catch (e) {}
    return nativeXhrOpen.apply(this, args);
  };

  if (typeof EventSource === 'function') {
    var NativeEventSource = EventSource;
    window.EventSource = function (u, config) {
      var target = null;
      try { target = toProxy(u); } catch (e) {}
      return new NativeEventSource(target || u, config);
    };
    window.EventSource.prototype = NativeEventSource.prototype;
  }

  if (navigator.sendBeacon) {
    var nativeBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (u, data) {
      var target = null;
      try { target = toProxy(u); } catch (e) {}
      return nativeBeacon(target || u, data);
    };
  }
})();
</script>`
}

function processHTML(content: string, pageUrl: string, proxyOrigin: string): string {
  const page = new URL(pageUrl)

  // Protocol-relative references -> absolute, using the page's protocol
  content = content.replace(/\b(href|src|action)=(["'])\/\/([^"']+)\2/gi, `$1=$2${page.protocol}//$3$2`)

  // Relative resources go through the proxy. Rewritten URLs must be ABSOLUTE
  // (proxy origin) because the injected <base> would otherwise resolve
  // "/api/proxy?..." against the target site.
  content = content.replace(/\b(src|data-src)=(["'])([^"']*)\2/gi, (match, attr: string, q: string, ref: string) => {
    if (!ref.trim() || isSkippableRef(ref)) return match
    try {
      return `${attr}=${q}${proxied(proxyOrigin, new URL(ref.trim(), pageUrl).href)}${q}`
    } catch {
      return match
    }
  })

  content = content.replace(/<link\b([^>]*?)\bhref=(["'])([^"']*)\2([^>]*)>/gi, (match, before: string, q: string, ref: string, after: string) => {
    if (!ref.trim() || isSkippableRef(ref)) return match
    try {
      return `<link${before}href=${q}${proxied(proxyOrigin, new URL(ref.trim(), pageUrl).href)}${q}${after}>`
    } catch {
      return match
    }
  })

  // <a> and <form> are left as-is: <base> resolves them and the injected
  // script intercepts clicks/submits and hands navigation to the parent app.
  const injection = `<base href="${page.href.replace(/"/g, "&quot;")}">
<meta name="referrer" content="no-referrer">
${buildInjectedScript(page.href, proxyOrigin)}`

  // Match <head> but not <header>
  const headRe = /<head(?:\s[^>]*)?>/i
  if (headRe.test(content)) return content.replace(headRe, (m) => `${m}\n${injection}`)
  const htmlRe = /<html(?:\s[^>]*)?>/i
  if (htmlRe.test(content)) return content.replace(htmlRe, (m) => `${m}\n<head>${injection}</head>`)
  return `<head>${injection}</head>\n${content}`
}

// ---------------------------------------------------------------------------
// Response building
// ---------------------------------------------------------------------------

async function buildProxyResponse(
  upstream: Response,
  finalUrl: string,
  proxyOrigin: string,
  raw = false,
  isHead = false,
): Promise<NextResponse> {
  const status = upstream.status
  const contentType = upstream.headers.get("content-type") || "application/octet-stream"
  const path = new URL(finalUrl).pathname.toLowerCase()

  // Lets the client tell upstream responses (even 404s) apart from proxy errors
  const baseHeaders: Record<string, string> = { "X-Proxy-Final-Url": finalUrl }

  if (status === 204 || status === 205 || status === 304) {
    return new NextResponse(null, { status, headers: baseHeaders })
  }

  // Raw mode (the page's own fetch/XHR calls): pass the body through untouched
  if (raw) {
    const headers: Record<string, string> = { ...baseHeaders, "Content-Type": contentType, "Cache-Control": "no-store" }
    const disposition = upstream.headers.get("content-disposition")
    if (disposition) headers["Content-Disposition"] = disposition
    // Streamed, so long-lived responses (EventSource, chunked APIs) keep working
    return new NextResponse(isHead ? null : upstream.body, { status, headers })
  }

  if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
    const html = processHTML(await upstream.text(), finalUrl, proxyOrigin)
    return new NextResponse(html, {
      status,
      headers: { ...baseHeaders, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    })
  }

  if (contentType.includes("javascript") || path.endsWith(".js") || path.endsWith(".mjs")) {
    const js = processJavaScript(await upstream.text(), finalUrl, proxyOrigin)
    return new NextResponse(js, {
      status,
      headers: { ...baseHeaders, "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600" },
    })
  }

  if (contentType.includes("text/css") || path.endsWith(".css")) {
    const css = processCSS(await upstream.text(), finalUrl, proxyOrigin)
    return new NextResponse(css, {
      status,
      headers: { ...baseHeaders, "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=3600" },
    })
  }

  const headers: Record<string, string> = {
    ...baseHeaders,
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=3600",
  }
  const etag = upstream.headers.get("etag")
  if (etag) headers.ETag = etag
  const disposition = upstream.headers.get("content-disposition")
  if (disposition) headers["Content-Disposition"] = disposition

  return new NextResponse(await upstream.arrayBuffer(), { status, headers })
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof BlockedUrlError) {
    return NextResponse.json({ error: error.message }, { status: 403 })
  }
  if (error instanceof TypeError && /invalid url/i.test(error.message)) {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 })
  }
  const msg =
    error instanceof Error ? (error.name === "AbortError" ? "Request timeout" : error.message) : "Unknown error"
  return NextResponse.json({ error: msg }, { status: error instanceof Error && error.name === "AbortError" ? 504 : 502 })
}

// Request headers from the page that must not be forwarded upstream
const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "cookie",
  "origin",
  "referer",
  "connection",
  "content-length",
  "accept-encoding",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "forwarded",
])

function forwardableHeaders(request: NextRequest): Record<string, string> {
  const out: Record<string, string> = {}
  request.headers.forEach((value, key) => {
    const k = key.toLowerCase()
    if (DROPPED_REQUEST_HEADERS.has(k) || k.startsWith("sec-") || k.startsWith("x-vercel") || k.startsWith("next-")) return
    if (k === "content-type") return // set from the body below
    out[k] = value
  })
  return out
}

async function handle(
  request: NextRequest,
  targetUrl: string,
  init: UpstreamInit,
  raw = false,
): Promise<NextResponse> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS)
  // Also stop the upstream fetch if the browser cancels (e.g. the Stop button)
  const onClientAbort = () => controller.abort()
  request.signal?.addEventListener("abort", onClientAbort)

  try {
    new URL(targetUrl) // validate early for a clean 400
    const { response, finalUrl } = await fetchUpstream(targetUrl, init, controller.signal)
    return await buildProxyResponse(response, finalUrl, request.nextUrl.origin, raw, init.method.toUpperCase() === "HEAD")
  } catch (error) {
    return errorResponse(error)
  } finally {
    clearTimeout(timeoutId)
    request.signal?.removeEventListener("abort", onClientAbort)
  }
}

/**
 * Raw mode: /api/proxy?url=<target>&raw=1 with any method. Used by the page's
 * own fetch()/XMLHttpRequest calls (rewritten by the injected script): the
 * method, body and most headers are forwarded, and the response is returned
 * without HTML/CSS/JS rewriting.
 */
async function handleRaw(request: NextRequest, targetUrl: string): Promise<NextResponse> {
  const method = request.method.toUpperCase()
  const hasBody = method !== "GET" && method !== "HEAD"
  const body = hasBody ? await request.arrayBuffer() : undefined
  return handle(
    request,
    targetUrl,
    {
      method,
      body: body && body.byteLength > 0 ? body : undefined,
      contentType: request.headers.get("content-type") || undefined,
      headers: forwardableHeaders(request),
    },
    true,
  )
}

function rawTarget(request: NextRequest): string | null {
  const params = request.nextUrl.searchParams
  return params.get("raw") === "1" ? params.get("url") : null
}

export async function GET(request: NextRequest) {
  const targetUrl = request.nextUrl.searchParams.get("url")
  if (!targetUrl) {
    return NextResponse.json({ error: "URL parameter is required" }, { status: 400 })
  }
  if (rawTarget(request)) return handleRaw(request, targetUrl)
  return handle(request, targetUrl, { method: "GET" })
}

export async function HEAD(request: NextRequest) {
  const targetUrl = request.nextUrl.searchParams.get("url")
  if (!targetUrl) return new NextResponse(null, { status: 400 })
  return handleRaw(request, targetUrl)
}

/**
 * Two modes:
 * - ?url=...&raw=1: raw passthrough (see handleRaw)
 * - JSON body { url: string, body?: string | object, contentType?: string }:
 *   used by the app for form submissions. A string body is forwarded as-is
 *   (urlencoded); an object body is sent as JSON, for backwards compatibility.
 */
export async function POST(request: NextRequest) {
  const raw = rawTarget(request)
  if (raw) return handleRaw(request, raw)

  const payload = await request.json().catch(() => ({}))
  const targetUrl = typeof payload?.url === "string" ? payload.url : ""
  if (!targetUrl) {
    return NextResponse.json({ error: "URL is required" }, { status: 400 })
  }

  let body: string | undefined
  let contentType: string | undefined
  if (typeof payload.body === "string") {
    body = payload.body
    contentType = typeof payload.contentType === "string" ? payload.contentType : "application/x-www-form-urlencoded"
  } else if (payload.body !== undefined && payload.body !== null) {
    body = JSON.stringify(payload.body)
    contentType = "application/json"
  }

  return handle(request, targetUrl, { method: "POST", body, contentType })
}

async function rawOnly(request: NextRequest): Promise<NextResponse> {
  const raw = rawTarget(request)
  if (!raw) return NextResponse.json({ error: "Only supported with raw=1" }, { status: 405 })
  return handleRaw(request, raw)
}

export const PUT = rawOnly
export const PATCH = rawOnly
export const DELETE = rawOnly
