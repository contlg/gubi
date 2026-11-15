package dev.homesev.drivelog.pleos;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Pure device derivation. Neither the VIN nor the private material is logged. */
public final class CarIdentity {
  public static String hash(String value) {
    try {
      byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
      StringBuilder out = new StringBuilder();
      for (byte b : bytes) {
        out.append(String.format(java.util.Locale.US, "%02x", b));
      }
      return out.toString();
    } catch (java.security.NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
  }

  public static String vinHash(String vin) {
    return vin != null && vin.matches("[A-HJ-NPR-Z0-9]{17}") ? hash("drivelog-vin-v1:" + vin) : null;
  }

  public static String fallbackVin(String live, String cached) {
    if (live != null && live.matches("[a-f0-9]{64}")) return live;
    return cached != null && cached.matches("[a-f0-9]{64}") ? cached : null;
  }

  public static String id(String androidId) {
    return "car-" + hash("drivelog-car-v2:" + androidId).substring(0, 12);
  }

  public static String secret(String androidId, String packageName) {
    return hash("drivelog-car-key-v2:" + androidId + ":" + packageName);
  }

  public static String carId(String id, String vinHash) {
    return id + "-" + vinHash.substring(0, 8);
  }

  public static String carSecret(String secret, String vinHash) {
    return hash("drivelog-car-vin-key-v1:" + secret + ":" + vinHash);
  }
}
