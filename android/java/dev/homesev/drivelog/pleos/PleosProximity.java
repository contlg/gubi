package dev.homesev.drivelog.pleos;

import android.content.Context;
import ai.pleos.playground.location.fused.FusedLocation;
import ai.pleos.playground.location.fused.listener.ProximityAlertListener;
import ai.pleos.playground.location.fused.model.*;
import dev.homesev.drivelog.AsyncScope;
import java.util.*;

/** Worker-owned registrations. Pending old registrations drain before a new window opens. */
final class PleosProximity {
  private static int reservations;
  private static synchronized boolean reserve(int count) {
    if (reservations + count > 4) return false;
    reservations += count;
    return true;
  }
  private static synchronized void releaseSlot() { reservations--; }

  interface Listener { void transition(int generation, int anchor, boolean enter); }
  private final AsyncScope scope;
  private final Listener output;
  private final PleosSdkThread sdk;
  private final Context context;
  private FusedLocation fused;
  private final Set<String> ids = new HashSet<>();
  private List<RouteAnchorPlanner.Anchor> desired = List.of();
  private int serial, pending, generation, first;
  private boolean closed, supported, released;

  PleosProximity(Context context, PleosSdkThread sdk, Listener output) {
    this.context = context;
    this.sdk = sdk;
    sdk.retain();
    scope = sdk.scope();
    this.output = output;
    scope.execute(this::initialize);
  }

  void permissionGranted() { scope.execute(this::initialize); }

  private void initialize() {
    if (closed || supported) return;
    try {
      if (fused == null) fused = new FusedLocation(context);
      supported = context.checkSelfPermission("pleos.car.permission.FUSED_LOCATION")
          == android.content.pm.PackageManager.PERMISSION_GRANTED && fused.isSupported();
      if (supported) { fused.initialize(); pump(); }
      android.util.Log.i("PleosProximity", "Initialized supported=" + supported);
    } catch (RuntimeException e) {
      supported = false;
      android.util.Log.w("PleosProximity", "Initialization failed", e);
    }
  }

  void window(int generation, int first, List<RouteAnchorPlanner.Anchor> anchors) {
    scope.execute(() -> {
      serial++;
      clear();
      this.generation = generation;
      this.first = first;
      desired = new ArrayList<>(anchors.subList(0, Math.min(2, anchors.size())));
      pump();
    });
  }

  private void clear() {
    for (String id : new ArrayList<>(ids)) {
      // A failed removal keeps its slot reserved; never exceed the registration budget.
      try { fused.removeProximityAlert(id); ids.remove(id); releaseSlot(); }
      catch (RuntimeException e) { android.util.Log.w("PleosProximity", "Remove failed", e); }
    }
  }

  private void pump() {
    if (closed || !supported || pending != 0 || !ids.isEmpty() || desired.isEmpty()) return;
    final int token = serial, g = generation, start = first;
    List<RouteAnchorPlanner.Anchor> window = desired;
    // Also bound overlapping managers during repeated stop/start with late SDK callbacks.
    if (!reserve(window.size())) {
      sdk.later(scope, this::pump, 1000);
      return;
    }
    desired = List.of();
    for (int i = 0; i < window.size(); i++) {
      RouteAnchorPlanner.Anchor anchor = window.get(i);
      final int index = start + i;
      pending++;
      try {
        fused.addProximityAlert(new ProximityAlertRequest(anchor.point.lat, anchor.point.lng, 60f,
            EnumSet.of(ProximityTransition.ENTER, ProximityTransition.EXIT)), new ProximityAlertListener() {
          private boolean completed;
          public void onRegistered(String id) {
            scope.execute(() -> {
              if (completed) return;
              completed = true;
              pending--;
              ids.add(id);
              android.util.Log.i("PleosProximity", "Registered anchor=" + index);
              if (closed || token != serial) { clear(); pump(); finishClose(); }
            });
          }
          public void onTransition(ProximityAlertEvent event) {
            scope.deliver(() -> {
              if (!closed && token == serial && event != null) {
                android.util.Log.i("PleosProximity", "Transition anchor=" + index
                    + " type=" + event.getTransition());
                output.transition(g, index, event.getTransition() == ProximityTransition.ENTER);
              }
            });
          }
          public void onError(Exception error) {
            scope.execute(() -> {
              if (!completed) { completed = true; pending--; releaseSlot(); }
              android.util.Log.w("PleosProximity", "Alert unavailable", error);
              if (token != serial) pump();
              finishClose();
            });
          }
        });
      } catch (RuntimeException e) {
        pending--;
        releaseSlot();
        android.util.Log.w("PleosProximity", "Register failed", e);
      }
    }
  }

  void close() {
    scope.execute(() -> { closed = true; serial++; desired = List.of(); clear(); finishClose(); });
  }
  private void finishClose() {
    if (closed && pending == 0 && !released) {
      released = true;
      try { if (fused != null) fused.release(); } catch (RuntimeException ignored) { }
      scope.close(sdk::close);
    }
  }
}
