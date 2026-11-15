package dev.homesev.drivelog.pleos;

import java.util.*;

public final class TripDispatchQueue {
  public static final class Job {
    final Object owner;
    final String name;
    final double lat, lng;
    final long queuedAt;
    long deadline;
    boolean cancelled;
    Job(Object owner, String name, double lat, double lng, long now) {
      this.owner = owner;
      this.name = name;
      this.lat = lat;
      this.lng = lng;
      queuedAt = now;
    }
  }
  private final ArrayDeque<Job> queue = new ArrayDeque<>();
  private Job pending;
  private long nextSend;

  public boolean ready(long now) {
    return pending == null && queue.isEmpty() && now >= nextSend;
  }

  public Job enqueue(Object owner, String name, double lat, double lng, long now) {
    if (!PleosFeedModel.coordinate(lat, lng) || !PleosFeedModel.text(name, 200) || name.isEmpty()
        || queue.size() >= 32) {
      throw new IllegalArgumentException("trip request");
    }
    if (pending != null && pending.name.equals(name)
        || queue.stream().anyMatch(j -> j.name.equals(name))) {
      throw new IllegalArgumentException("duplicate trip");
    }
    Job j = new Job(owner, name, lat, lng, now);
    queue.add(j);
    return j;
  }

  public Job start(long now) {
    if (pending != null || now < nextSend || queue.isEmpty()) {
      return null;
    }
    pending = queue.remove();
    pending.deadline = now + 5000;
    nextSend = now + 1000;
    return pending;
  }

  public Job accept(String name, long now) {
    if (pending == null || now >= pending.deadline || !pending.name.equals(name)) {
      return null;
    }
    Job j = pending;
    pending = null;
    return j;
  }

  public Job expire(long now) {
    if (pending == null || now < pending.deadline) {
      return null;
    }
    Job j = pending;
    pending = null;
    return j;
  }

  public List<Job> expireWaiting(long now) {
    List<Job> expired = new ArrayList<>();
    queue.removeIf(j -> {
      if (now - j.queuedAt < 5000) {
        return false;
      }
      expired.add(j);
      return true;
    });
    return expired;
  }

  public List<Job> cancel(Object owner) {
    List<Job> removed = new ArrayList<>();
    queue.removeIf(j -> {
      if (j.owner != owner) {
        return false;
      }
      j.cancelled = true;
      removed.add(j);
      return true;
    });
    if (pending != null && pending.owner == owner) {
      pending.cancelled = true;
      removed.add(pending);
    }
    return removed;
  }
}
