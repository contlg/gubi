package dev.homesev.drivelog;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

/**
 * 빌려쓰기 모드의 "어떤 요청을 Firebase 화면으로 바꿔 줄지" 규칙. 안드로이드 의존이 없어
 * 컴퓨터에서 바로 시험한다(tests/.../BorrowUiRuleTest).
 *
 * 바꿔 주는 것: GET, https, 호스트가 웹 주소 호스트와 같고, 경로가 정확히 접두어(/gubi)이거나
 * 접두어 + "/" 로 시작하는 요청뿐. 그 밖(POST, /api/..., /gubix 등)은 손대지 않는다.
 */
public final class BorrowUiRule {
  private BorrowUiRule() {}

  public static boolean matches(
      String method, String scheme, String host, String path, String expectedHost, String prefix) {
    if (method == null || !"GET".equalsIgnoreCase(method)) return false;
    if (scheme == null || !"https".equalsIgnoreCase(scheme)) return false;
    if (host == null || expectedHost == null || expectedHost.isEmpty()) return false;
    if (!host.equalsIgnoreCase(expectedHost)) return false;
    if (path == null || prefix == null || prefix.isEmpty()) return false;
    if (!(path.equals(prefix) || path.startsWith(prefix + "/"))) return false;
    // 경로 거슬러 오르기(/gubi/../api)나 역슬래시는 받지 않는다.
    String lower = path.toLowerCase(Locale.ROOT);
    if (lower.contains("\\") || lower.contains("%2e") || lower.contains("%2f")
        || lower.contains("%5c")) {
      return false;
    }
    for (String seg : path.split("/", -1)) {
      if (seg.equals("..") || seg.equals(".")) return false;
    }
    return true;
  }

  /** Firebase 주소 = 원본 + 같은 경로(인코딩 유지) + 같은 쿼리. */
  public static String upstreamUrl(String origin, String encodedPath, String encodedQuery) {
    StringBuilder b = new StringBuilder(stripSlash(origin)).append(encodedPath);
    if (encodedQuery != null && !encodedQuery.isEmpty()) b.append('?').append(encodedQuery);
    return b.toString();
  }

  /** 넘겨받은 주소가 UI 원본(https://host[:port])과 같은 출처인지. 넘겨주기 따라갈 때 쓴다. */
  public static boolean sameOrigin(String origin, String url) {
    try {
      URI a = new URI(stripSlash(origin));
      URI b = new URI(url);
      if (a.getScheme() == null || b.getScheme() == null || a.getHost() == null
          || b.getHost() == null) {
        return false;
      }
      return a.getScheme().equalsIgnoreCase(b.getScheme())
          && a.getHost().equalsIgnoreCase(b.getHost())
          && port(a) == port(b);
    } catch (Exception e) {
      return false;
    }
  }

  private static int port(URI u) {
    if (u.getPort() != -1) return u.getPort();
    return "https".equalsIgnoreCase(u.getScheme()) ? 443 : "http".equalsIgnoreCase(u.getScheme()) ? 80 : -1;
  }

  /** 경로 + 쿼리의 SHA-256 16진수 — 저장 파일 이름. */
  public static String cacheKey(String encodedPath, String encodedQuery) {
    String s = encodedPath + (encodedQuery == null || encodedQuery.isEmpty() ? "" : "?" + encodedQuery);
    try {
      byte[] h = MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
      StringBuilder b = new StringBuilder(h.length * 2);
      for (byte x : h) b.append(String.format(Locale.ROOT, "%02x", x));
      return b.toString();
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }

  /**
   * Content-Type → {mime, charset}. charset이 없으면 null. Content-Type이 없으면 경로 끝으로 짐작한다.
   */
  public static String[] parseContentType(String contentType, String path) {
    String mime = null, charset = null;
    if (contentType != null) {
      String[] parts = contentType.split(";");
      String m = parts[0].trim().toLowerCase(Locale.ROOT);
      if (!m.isEmpty()) mime = m;
      for (int i = 1; i < parts.length; i++) {
        String p = parts[i].trim();
        int eq = p.indexOf('=');
        if (eq > 0 && p.substring(0, eq).trim().equalsIgnoreCase("charset")) {
          String v = p.substring(eq + 1).trim();
          if (v.length() >= 2 && v.startsWith("\"") && v.endsWith("\"")) v = v.substring(1, v.length() - 1);
          if (!v.isEmpty()) charset = v;
        }
      }
    }
    if (mime == null) mime = guessMime(path);
    return new String[] {mime, charset};
  }

  static String guessMime(String path) {
    String p = path == null ? "" : path.toLowerCase(Locale.ROOT);
    int q = p.indexOf('?');
    if (q >= 0) p = p.substring(0, q);
    String last = p.substring(p.lastIndexOf('/') + 1);
    int dot = last.lastIndexOf('.');
    if (dot < 0) return "text/html";
    switch (last.substring(dot + 1)) {
      case "html": case "htm": return "text/html";
      case "js": case "mjs": return "application/javascript";
      case "css": return "text/css";
      case "json": case "webmanifest": return "application/json";
      case "txt": return "text/plain";
      case "svg": return "image/svg+xml";
      case "png": return "image/png";
      case "jpg": case "jpeg": return "image/jpeg";
      case "webp": return "image/webp";
      case "ico": return "image/x-icon";
      case "woff2": return "font/woff2";
      case "woff": return "font/woff";
      default: return "application/octet-stream";
    }
  }

  /** WebResourceResponse는 빈 사유 문구를 거부한다 — 항상 비지 않은 문구를 돌려준다. */
  public static String reason(int status, String given) {
    if (given != null && !given.trim().isEmpty()) return given.trim();
    switch (status) {
      case 200: return "OK";
      case 203: return "Non-Authoritative Information";
      case 204: return "No Content";
      case 206: return "Partial Content";
      case 400: return "Bad Request";
      case 403: return "Forbidden";
      case 404: return "Not Found";
      case 410: return "Gone";
      case 429: return "Too Many Requests";
      case 500: return "Internal Server Error";
      case 502: return "Bad Gateway";
      case 503: return "Service Unavailable";
      case 504: return "Gateway Timeout";
      default: return status >= 500 ? "Server Error" : status >= 400 ? "Client Error" : "OK";
    }
  }

  private static String stripSlash(String s) {
    return s != null && s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
  }
}
