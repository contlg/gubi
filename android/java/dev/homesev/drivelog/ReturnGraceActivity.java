package dev.homesev.drivelog;

import android.app.Activity;
import android.os.Bundle;

/**
 * 보이지 않고 바로 닫히는 화면. 현대 내비 안내를 끄기 직전에 띄운다.
 * 안드로이드는 최근 10초 안에 화면을 띄운 앱만 뒤에서 다시 앞으로 나오게 허용한다.
 * 그래서 이 화면을 띄워 두면, 순정 내비가 앞으로 튀어나왔을 때 우리 앱이 되돌아올 수 있다.
 */
public class ReturnGraceActivity extends Activity {
  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    finish();
    overridePendingTransition(0, 0);
  }
}
