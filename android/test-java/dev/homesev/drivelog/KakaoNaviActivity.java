package dev.homesev.drivelog;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.graphics.Color;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.view.Gravity;
import androidx.appcompat.app.AppCompatActivity;
import com.kakaomobility.knsdk.KNSDK;
import com.kakaomobility.knsdk.KNLanguageType;
import com.kakaomobility.knsdk.KNRoutePriority;
import com.kakaomobility.knsdk.guidance.knguidance.*;
import com.kakaomobility.knsdk.ui.view.KNNaviView;
import com.kakaomobility.knsdk.ui.view.KNNaviView_GuideStateDelegate;
import kotlin.Unit;
import java.lang.reflect.Proxy;

/** Official in-app navigation SDK evaluation. Safe-driving only, no destination. */
public final class KakaoNaviActivity extends AppCompatActivity {
  private static boolean installed;
  private KNNaviView navi;
  private FrameLayout root;
  private TextView status;
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    root = new FrameLayout(this);
    status = new TextView(this);
    status.setText("카카오내비 주행화면 준비 중…");
    status.setTextColor(Color.WHITE); status.setBackgroundColor(Color.rgb(25,28,35));
    status.setTextSize(20); status.setGravity(Gravity.CENTER);
    root.addView(status, new FrameLayout.LayoutParams(-1,-1)); setContentView(root);
    if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION}, 101); return;
    }
    initialize();
  }
  @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
    super.onRequestPermissionsResult(code,permissions,results);
    if(code==101 && results.length>0 && results[0]==PackageManager.PERMISSION_GRANTED) initialize();
  }
  private void initialize() {
    if(BuildConfig.KAKAO_NATIVE_APP_KEY.isEmpty()){status.setText("카카오 네이티브 키 설정이 필요해요");return;}
    if(!installed){KNSDK.INSTANCE.install(getApplication(),getFilesDir()+"/kakao-navi");installed=true;}
    KNSDK.INSTANCE.initializeWithAppKey(BuildConfig.KAKAO_NATIVE_APP_KEY,BuildConfig.VERSION_NAME,null,null,
      KNLanguageType.KNLanguageType_KOREAN,error->{runOnUiThread(()->{
        if(isFinishing()||isDestroyed())return;
        if(error!=null){status.setText("카카오내비 초기화 실패: "+error.getCode());android.util.Log.w("FundriveKakaoNavi","Initialization failed: "+error.getCode());return;}
        try {showMap();}catch(RuntimeException|LinkageError e){status.setText("카카오내비 화면 실행 실패");android.util.Log.e("FundriveKakaoNavi","View initialization failed",e);}
      });return Unit.INSTANCE;});
  }
  /** Forward documented SDK delegates to their matching KNNaviView callbacks. */
  @SuppressWarnings("unchecked") private <T> T forward(Class<T> type) {
    return (T)Proxy.newProxyInstance(type.getClassLoader(),new Class<?>[]{type},(proxy,method,args)->{
      if(method.getDeclaringClass()==Object.class) {
        if(method.getName().equals("toString"))return "FundriveKakaoDelegate";
        if(method.getName().equals("hashCode"))return System.identityHashCode(proxy);
        return proxy==args[0];
      }
      if(method.getName().equals("guidanceGuideEnded")){navi.guidanceGuideEnded((KNGuidance)args[0],true);return null;}
      try{return navi.getClass().getMethod(method.getName(),method.getParameterTypes()).invoke(navi,args);}
      catch(NoSuchMethodException e){return method.getReturnType()==boolean.class?true:null;}
    });
  }
  private void showMap() {
    navi=new KNNaviView(this);
    navi.setGuideStateDelegate(new KNNaviView_GuideStateDelegate() {
      public void naviViewGuideState(KNGuideState state) {}
      public void naviViewGuideEnded() { if (!isFinishing()) finish(); }
    });
    KNGuidance guidance=KNSDK.INSTANCE.sharedGuidance();
    if(guidance==null){status.setText("카카오내비 안내 엔진을 시작하지 못했어요");return;}
    guidance.setGuideStateDelegate(forward(KNGuidance_GuideStateDelegate.class));
    guidance.setLocationGuideDelegate(forward(KNGuidance_LocationGuideDelegate.class));
    guidance.setRouteGuideDelegate(forward(KNGuidance_RouteGuideDelegate.class));
    guidance.setSafetyGuideDelegate(forward(KNGuidance_SafetyGuideDelegate.class));
    guidance.setVoiceGuideDelegate(forward(KNGuidance_VoiceGuideDelegate.class));
    guidance.setCitsGuideDelegate(forward(KNGuidance_CitsGuideDelegate.class));
    root.addView(navi,0,new FrameLayout.LayoutParams(-1,-1));
    navi.initWithGuidance(guidance,null,KNRoutePriority.KNRoutePriority_Recommand,0);
    root.removeView(status);
    android.util.Log.i("FundriveKakaoNavi","Safe-driving view initialized");
  }
  @Override protected void onResume(){super.onResume();if(installed){KNSDK.INSTANCE.handleWillEnterForeground();KNSDK.INSTANCE.handleDidBecomeActive();}}
  @Override protected void onPause(){if(installed){KNSDK.INSTANCE.handleWillResignActive();KNSDK.INSTANCE.handleDidEnterBackground();}super.onPause();}
  @Override protected void onDestroy(){if(navi!=null && KNSDK.INSTANCE.sharedGuidance()!=null)KNSDK.INSTANCE.sharedGuidance().stop();super.onDestroy();}
}
