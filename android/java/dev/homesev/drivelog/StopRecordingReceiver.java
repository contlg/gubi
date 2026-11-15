package dev.homesev.drivelog;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Explicit, app-private notification command; never creates a background service. */
public final class StopRecordingReceiver extends BroadcastReceiver {
  @Override public void onReceive(Context context, Intent intent) {
    TrackService.stopRecording(context);
  }
}
