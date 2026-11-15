package dev.homesev.drivelog;

/** Reproduction diagnostics only; never log locations, route payloads, VINs or credentials. */
public final class FundriveDiag {
  private FundriveDiag() {}
  public static boolean enabled() { return "carTest".equals(BuildConfig.BUILD_TYPE); }
  public static void log(String message) {
    if (enabled()) android.util.Log.i("FundriveDiag", message);
  }
}
