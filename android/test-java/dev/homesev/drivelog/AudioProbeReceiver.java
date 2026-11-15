package dev.homesev.drivelog;
/** Test APK only, shell DUMP permission. Invokes the real WebView bridge or the real TTS gate. */
public final class AudioProbeReceiver extends android.content.BroadcastReceiver {
  @Override public void onReceive(android.content.Context c,android.content.Intent i){
    MainActivity.debugAudioCommand(i.getStringExtra("cmd"),i.getStringExtra("drivePlan"));
  }
}
