package dev.homesev.drivelog;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 빌려쓰기 모드: drivelog 주소의 /gubi 화면 요청(GET)만 Firebase(UI_ORIGIN)에서 받아 대신 돌려준다.
 * /api 등 나머지는 null을 돌려 WebView가 drivelog 서버로 그대로 보낸다.
 * WebView의 입출력 스레드에서 불린다 — 화면(View)은 건드리지 않는다.
 */
final class BorrowUi {
  private static final String TAG = "FundriveBorrow";
  private static final int CONNECT_MS = 8_000;
  private static final int READ_MS = 15_000;
  private static final int MAX_REDIRECTS = 5;
  private static final int MAX_BODY = 20 * 1024 * 1024;
  private static final long CACHE_BYTES = 30L * 1024 * 1024;
  private static final String[] KEEP_HEADERS = {"Cache-Control", "ETag", "Last-Modified", "Content-Type"};
  private static final String OFFLINE_HTML =
      "<!doctype html><html lang=\"ko\"><head><meta charset=\"utf-8\">"
          + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
          + "<title>Gubi</title></head>"
          + "<body style=\"font-family:sans-serif;padding:2em;text-align:center\">"
          + "<p>화면을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.</p></body></html>";

  private final String host;
  private final String origin;
  private final String prefix;
  private final BorrowUiCache cache;

  BorrowUi(Context c, String webUrl, String uiOrigin, String uiPrefix) {
    this.host = Uri.parse(webUrl).getHost();
    this.origin = uiOrigin;
    this.prefix = uiPrefix;
    this.cache = new BorrowUiCache(new File(c.getCacheDir(), "borrow-ui"), CACHE_BYTES);
  }

  /** 바꿔 줄 요청이 아니면 null — WebView가 원래대로 처리한다. */
  WebResourceResponse intercept(WebResourceRequest req) {
    if (req == null || req.getUrl() == null) return null;
    Uri u = req.getUrl();
    if (!BorrowUiRule.matches(req.getMethod(), u.getScheme(), u.getHost(), u.getEncodedPath(), host, prefix)) {
      return null;
    }
    String path = u.getEncodedPath();
    String query = u.getEncodedQuery();
    String key = BorrowUiRule.cacheKey(path, query);
    Fetched fresh = null;
    try {
      fresh = fetch(BorrowUiRule.upstreamUrl(origin, path, query), path, req.getRequestHeaders());
    } catch (IOException | RuntimeException e) {
      android.util.Log.w(TAG, "fetch failed " + path + ": " + e);
    }
    int status = fresh == null ? 0 : fresh.entry.status;
    if (status == 200) {
      cache.put(key, fresh.entry);
      return toResponse(fresh.entry, fresh.reason);
    }
    // 네트워크 실패·서버 오류(5xx)·뜻밖의 3xx(304 등) → 저장본이 있으면 그것을 쓴다.
    boolean redirectish = status >= 300 && status < 400;
    if (fresh == null || status >= 500 || redirectish) {
      BorrowUiCache.Entry saved = cache.get(key);
      if (saved != null) return toResponse(saved, null);
    }
    // 404 같은 정상 오류 응답(저장본 없는 5xx 포함)은 진짜 상태 그대로 보여 준다. 저장하지 않는다.
    if (fresh != null && status >= 200 && !redirectish) return toResponse(fresh.entry, fresh.reason);
    return offline();
  }

  private static final class Fetched {
    final BorrowUiCache.Entry entry;
    final String reason;

    Fetched(BorrowUiCache.Entry entry, String reason) {
      this.entry = entry;
      this.reason = reason;
    }
  }

  private Fetched fetch(String target, String path, Map<String, String> reqHeaders)
      throws IOException {
    String accept = header(reqHeaders, "Accept");
    String lang = header(reqHeaders, "Accept-Language");
    URL url = new URL(target);
    for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
      HttpURLConnection con = (HttpURLConnection) url.openConnection();
      try {
        con.setInstanceFollowRedirects(false);
        con.setUseCaches(false);
        con.setConnectTimeout(CONNECT_MS);
        con.setReadTimeout(READ_MS);
        con.setRequestMethod("GET");
        // 조건부 요청(If-None-Match 등)은 일부러 보내지 않는다: 304는 WebView에 돌려줄 수 없다.
        if (accept != null) con.setRequestProperty("Accept", accept);
        if (lang != null) con.setRequestProperty("Accept-Language", lang);
        int status = con.getResponseCode();
        if (status >= 300 && status < 400 && status != 304) {
          String loc = con.getHeaderField("Location");
          if (loc == null) throw new IOException("redirect without Location");
          URL next = new URL(url, loc);
          if (!BorrowUiRule.sameOrigin(origin, next.toString())) {
            throw new IOException("redirect leaves UI origin: " + next.getHost());
          }
          url = next;
          continue;
        }
        Map<String, String> headers = new LinkedHashMap<>();
        for (String name : KEEP_HEADERS) {
          String v = con.getHeaderField(name);
          if (v != null) headers.put(name, v);
        }
        String[] type = BorrowUiRule.parseContentType(con.getContentType(), path);
        byte[] body = new byte[0];
        if (status != 304) {
          InputStream in = status >= 400 ? con.getErrorStream() : con.getInputStream();
          if (in != null) {
            try (InputStream s = in) {
              body = readAll(s);
            }
          }
        }
        android.util.Log.i(TAG, status + " " + path);
        return new Fetched(new BorrowUiCache.Entry(status, type[0], type[1], headers, body),
            con.getResponseMessage());
      } finally {
        con.disconnect();
      }
    }
    throw new IOException("too many redirects");
  }

  private static byte[] readAll(InputStream in) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream(64 * 1024);
    byte[] buf = new byte[32 * 1024];
    int n;
    while ((n = in.read(buf)) > 0) {
      out.write(buf, 0, n);
      if (out.size() > MAX_BODY) throw new IOException("body too large");
    }
    return out.toByteArray();
  }

  private static String header(Map<String, String> h, String name) {
    if (h == null) return null;
    for (Map.Entry<String, String> e : h.entrySet()) {
      if (e.getKey() != null && e.getKey().equalsIgnoreCase(name)) return e.getValue();
    }
    return null;
  }

  private static WebResourceResponse toResponse(BorrowUiCache.Entry e, String reason) {
    Map<String, String> headers = new LinkedHashMap<>(e.headers);
    // WebResourceResponse는 300~399 상태를 받지 않는다(여기까지 오지 않지만 방어).
    int status = e.status >= 300 && e.status < 400 ? 502 : e.status;
    String phrase = BorrowUiRule.reason(status, status == e.status ? reason : null);
    return new WebResourceResponse(e.mime, e.charset, status, phrase,
        headers, new ByteArrayInputStream(e.body));
  }

  private static WebResourceResponse offline() {
    Map<String, String> headers = new LinkedHashMap<>();
    headers.put("Content-Type", "text/html; charset=utf-8");
    headers.put("Cache-Control", "no-store");
    return new WebResourceResponse("text/html", "utf-8", 503, "Service Unavailable", headers,
        new ByteArrayInputStream(OFFLINE_HTML.getBytes(StandardCharsets.UTF_8)));
  }
}
