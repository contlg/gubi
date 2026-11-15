package dev.homesev.drivelog.pleos;

/** Only next-anchor ENTER/EXIT pairs can prove passage; other events do not pause guidance. */
public final class ProximityPass {
  private int generation = -1, next = -1;
  private boolean entered, passed;

  public void window(int generation, int next) {
    if (this.generation != generation || this.next != next) {
      this.generation = generation;
      this.next = next;
      entered = passed = false;
    }
  }

  public boolean transition(int generation, int anchor, boolean enter, boolean eligible,
      double arc, double anchorArc, double lateral, boolean headingOk) {
    if (this.generation != generation || next != anchor || passed || !eligible) return false;
    if (enter) {
      entered = true;
      return false;
    }
    boolean accept = entered && Double.isFinite(arc) && arc >= anchorArc
        && Double.isFinite(lateral) && lateral <= CourseProgress.ON_COURSE_M && headingOk;
    entered = false;
    if (accept) passed = true;
    return accept;
  }
}
