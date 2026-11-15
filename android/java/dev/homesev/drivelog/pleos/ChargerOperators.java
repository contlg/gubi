package dev.homesev.drivelog.pleos;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** 안전 피드와 별도로 보관하는 4 KB 이내의 재생 가능한 표본. */
public final class ChargerOperators {
  private volatile String json = "null";
  private int total;

  public String json() {
    return json;
  }

  public int total() {
    return total;
  }

  public boolean update(List<Map<String, Object>> items) {
    int count = items == null ? 0 : items.size();
    List<Map<String, Object>> kept = new ArrayList<>();
    for (Map<String, Object> item : items == null ? List.<Map<String, Object>>of() : items) {
      if (item == null || !(item.get("id") instanceof String)
          || !(item.get("name") instanceof String)) {
        continue;
      }
      String id = (String) item.get("id"), name = (String) item.get("name");
      if (!PleosFeedModel.text(id, 32) || !PleosFeedModel.text(name, 40)
          || id.isEmpty() || name.isEmpty()) {
        continue;
      }
      if (kept.size() >= 200) {
        break;
      }
      kept.add(PleosFeedModel.object("id", id, "name", name));
      if (encode(kept, count).getBytes(StandardCharsets.UTF_8).length > 4096) {
        kept.remove(kept.size() - 1);
        break;
      }
    }
    String next = encode(kept, count);
    boolean changed = !next.equals(json);
    total = count;
    json = next;
    return changed;
  }

  private static String encode(List<Map<String, Object>> items, int total) {
    return PleosFeedModel.json(PleosFeedModel.object("items", items, "total", total,
        "truncated", items.size() < total));
  }
}
