package dev.homesev.drivelog;

import android.content.Context;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/** Last owner permits offline recording; current owner alone permits uploads. */
final class QueueOwner {
  static final String UNASSIGNED = "unassigned";
  private static volatile String current;
  private static String offline;

  static boolean valid(String owner) { return owner != null && owner.matches("[a-f0-9]{16,64}"); }
  static synchronized void suspend() { current = null; offline = null; }
  static String current() { return current; }
  static synchronized void resolved(Context c, String owner) {
    offline = null;
    current = valid(owner) ? owner : null;
    if (current != null) c.getSharedPreferences("queue_owner", 0).edit().putString("last", current).apply();
  }
  static synchronized void logout(Context c) {
    current = null;
    offline = null;
    c.getSharedPreferences("queue_owner", 0).edit().remove("last").apply();
  }
  static String recording(Context c) {
    String owner = c.getSharedPreferences("queue_owner", 0).getString("last", null);
    return valid(owner) ? owner : UNASSIGNED;
  }
  /** Offline confirmation permits recording only; it never authorizes uploads. */
  static synchronized void allowOffline(Context c, String owner) {
    if (current == null && valid(owner) && owner.equals(recording(c))) offline = owner;
  }
  static synchronized String starting(Context c) {
    if (current != null) return current;
    return valid(offline) && offline.equals(recording(c)) ? offline : UNASSIGNED;
  }
  static String read(File dir) {
    try {
      String owner = new String(Files.readAllBytes(new File(dir, "owner").toPath()), StandardCharsets.UTF_8);
      return valid(owner) ? owner : UNASSIGNED;
    } catch (Exception e) { return UNASSIGNED; }
  }
  static void write(File dir, String owner) {
    try {
      Files.write(new File(dir, "owner").toPath(), (valid(owner) ? owner : UNASSIGNED).getBytes(StandardCharsets.UTF_8));
    } catch (Exception e) { throw new IllegalStateException("Queue owner unavailable", e); }
  }
}
