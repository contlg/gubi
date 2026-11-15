package dev.homesev.drivelog;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 빌려쓰기 화면의 오프라인 대비 저장소. 성공(200) 응답만 파일 하나(설명 + 본문)로 저장한다.
 * 쓰기는 임시 파일에 다 쓰고 fsync 뒤 이름 바꾸기라, 쓰다 죽어도 반쪽 파일이 나중에 쓰이지 않는다.
 * 전체가 상한을 넘으면 가장 오래 안 쓴 것부터 지운다. 안드로이드 의존이 없다.
 */
public final class BorrowUiCache {
  private static final int MAGIC = 0x46445543; // "FDUC"
  private static final int VERSION = 1;
  private static final String EXT = ".bin";

  public static final class Entry {
    public final int status;
    public final String mime;
    public final String charset;
    public final Map<String, String> headers;
    public final byte[] body;

    public Entry(int status, String mime, String charset, Map<String, String> headers, byte[] body) {
      this.status = status;
      this.mime = mime;
      this.charset = charset;
      this.headers = headers == null ? new LinkedHashMap<>() : headers;
      this.body = body;
    }
  }

  private final File dir;
  private final long maxBytes;

  public BorrowUiCache(File dir, long maxBytes) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    dir.mkdirs();
    // 지난번에 쓰다 만 임시 파일 정리
    File[] tmps = dir.listFiles((d, n) -> n.endsWith(".tmp"));
    if (tmps != null) for (File t : tmps) t.delete();
  }

  private File file(String key) {
    return new File(dir, key + EXT);
  }

  /** 없거나 깨졌으면 null. */
  public Entry get(String key) {
    File f = file(key);
    if (!f.isFile()) return null;
    byte[] raw;
    try (FileInputStream in = new FileInputStream(f)) {
      raw = in.readAllBytes();
    } catch (IOException e) {
      return null;
    }
    try (DataInputStream in = new DataInputStream(new ByteArrayInputStream(raw))) {
      if (in.readInt() != MAGIC || in.readInt() != VERSION) return null;
      int status = in.readInt();
      String mime = in.readUTF();
      String charset = in.readUTF();
      int n = in.readInt();
      if (n < 0 || n > 64) return null;
      Map<String, String> headers = new LinkedHashMap<>();
      for (int i = 0; i < n; i++) headers.put(in.readUTF(), in.readUTF());
      int len = in.readInt();
      if (len < 0 || len != in.available()) return null;
      byte[] body = new byte[len];
      in.readFully(body);
      f.setLastModified(System.currentTimeMillis());
      return new Entry(status, mime, charset.isEmpty() ? null : charset, headers, body);
    } catch (IOException | RuntimeException e) {
      return null;
    }
  }

  /** 200 응답만 저장한다. 실패해도 조용히 넘어간다(저장소는 덤). */
  public void put(String key, Entry e) {
    if (e == null || e.status != 200 || e.body == null) return;
    if (e.body.length > maxBytes / 4) return;
    byte[] data;
    try {
      ByteArrayOutputStream buf = new ByteArrayOutputStream(e.body.length + 512);
      DataOutputStream out = new DataOutputStream(buf);
      out.writeInt(MAGIC);
      out.writeInt(VERSION);
      out.writeInt(e.status);
      out.writeUTF(e.mime == null ? "application/octet-stream" : e.mime);
      out.writeUTF(e.charset == null ? "" : e.charset);
      Map<String, String> h = new LinkedHashMap<>();
      for (Map.Entry<String, String> x : e.headers.entrySet()) {
        if (x.getKey() != null && x.getValue() != null && h.size() < 64) h.put(x.getKey(), x.getValue());
      }
      out.writeInt(h.size());
      for (Map.Entry<String, String> x : h.entrySet()) {
        out.writeUTF(x.getKey());
        out.writeUTF(x.getValue());
      }
      out.writeInt(e.body.length);
      out.write(e.body);
      out.flush();
      data = buf.toByteArray();
    } catch (IOException ex) {
      return;
    }
    File tmp = new File(dir, key + "." + Thread.currentThread().getId() + "." + System.nanoTime() + ".tmp");
    try {
      try (FileOutputStream fo = new FileOutputStream(tmp)) {
        fo.write(data);
        fo.getFD().sync();
      }
      synchronized (this) {
        if (!tmp.renameTo(file(key))) {
          tmp.delete();
          return;
        }
        evict();
      }
    } catch (IOException ex) {
      tmp.delete();
    }
  }

  /** 합계가 상한을 넘으면 오래된 것부터 지운다. */
  private void evict() {
    File[] files = dir.listFiles((d, n) -> n.endsWith(EXT));
    if (files == null) return;
    long total = 0;
    for (File f : files) total += f.length();
    if (total <= maxBytes) return;
    final long[] stamp = new long[files.length];
    for (int i = 0; i < files.length; i++) stamp[i] = files[i].lastModified();
    Integer[] order = new Integer[files.length];
    for (int i = 0; i < order.length; i++) order[i] = i;
    Arrays.sort(order, Comparator.comparingLong(i -> stamp[i]));
    for (Integer i : order) {
      if (total <= maxBytes) break;
      long len = files[i].length();
      if (files[i].delete()) total -= len;
    }
  }
}
