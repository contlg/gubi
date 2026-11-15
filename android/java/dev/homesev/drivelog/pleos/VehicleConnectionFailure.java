package dev.homesev.drivelog.pleos;

/**
 * Uses public ErrorCode identifiers and Throwable APIs, never the obfuscated exception accessor.
 * Unknown error formats stay local; a vendor-supported typed accessor would remove this limitation.
 * https://document.pleos.ai/en/docs/pleos-only/connect-sdk-pleos/Vehicle/vehicle-error-code
 */
final class VehicleConnectionFailure {
  static boolean isConnectionFailure(Throwable error) {
    for (int depth = 0; error != null && depth < 8; depth++, error = error.getCause()) {
      if (error instanceof SecurityException || error instanceof IllegalArgumentException
          || error instanceof UnsupportedOperationException) return false;
      String message = error.getMessage();
      if (message != null) {
        // ErrorCode enum은 컴파일 classpath에 없어(2.3.2 AAR) 공개 문서의 오류 이름 문자열로만 판단한다.
        if (message.contains("ERROR_SERVICE_CONNECTION_FAILURE")
            || message.contains("ERROR_INTERNAL_SERVICE")) {
          return true;
        }
        if (message.startsWith("ERROR_")) {
          return false;
        }
      }
      if (error instanceof android.os.RemoteException) return true;
      if (error instanceof IllegalStateException && message != null) {
        String lower = message.toLowerCase(java.util.Locale.ROOT);
        if (lower.contains("not connected") || lower.contains("disconnected")
            || lower.contains("binder") || lower.contains("service unavailable")) return true;
      }
    }
    return false;
  }
}
