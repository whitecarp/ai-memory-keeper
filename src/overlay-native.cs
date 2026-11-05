// Win32 helpers and her motion for overlay.ps1 (compiled with Add-Type -Path against
// the WPF assemblies; Windows PowerShell's compiler takes C# 5 only; ASCII only).
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
using System.Globalization; using System.IO; using System.Windows; using System.Windows.Controls;
using System.Windows.Documents; using System.Windows.Media; using System.Windows.Media.Animation;
using System.Windows.Media.Effects; using System.Windows.Media.Imaging; using System.Windows.Shapes;
using System.Windows.Threading;
public static class AmkNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct PE32 {
    public uint dwSize, cntUsage, th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID, cntThreads, th32ParentProcessID;
    public int pcPriClassBase; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile; }
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint f, uint p);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr h, ref PE32 e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr h, ref PE32 e);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  // The agent's window. First its console: on Windows 11 a PowerShell opened from the
  // Start menu is shown by Windows Terminal without Terminal being its parent process,
  // but the console window it writes to is owned by the Terminal window (classic
  // consoles return the visible console window itself). Otherwise walk up from the
  // process that ran the hook (the agent, its shell, then the editor / desktop app) to
  // the nearest ancestor that owns a normal top-level window, never the desktop shell.
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  static bool Usable(IntPtr h) {
    if (h == IntPtr.Zero || !IsWindowVisible(h)) return false;
    RECT r; return GetWindowRect(h, out r) && r.Right - r.Left >= 300 && r.Bottom - r.Top >= 200;
  }
  public static IntPtr ConsoleWindowOf(uint pid) {
    FreeConsole();                       // this overlay's own hidden console
    if (!AttachConsole(pid)) return IntPtr.Zero;
    IntPtr h = GetConsoleWindow();
    FreeConsole();                       // detach again at once; nothing is read or written
    if (h == IntPtr.Zero) return IntPtr.Zero;
    IntPtr owner = GetAncestor(h, 3);    // GA_ROOTOWNER: the terminal window for ConPTY consoles
    if (owner != IntPtr.Zero && owner != h && Usable(owner)) return owner;
    return Usable(h) ? h : IntPtr.Zero;
  }
  static void Snapshot(Dictionary<uint, uint> parent, Dictionary<uint, string> exe) {
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return;
    var e = new PE32(); e.dwSize = (uint)Marshal.SizeOf(typeof(PE32));
    if (Process32FirstW(snap, ref e)) do { parent[e.th32ProcessID] = e.th32ParentProcessID; exe[e.th32ProcessID] = (e.szExeFile ?? "").ToLowerInvariant(); } while (Process32NextW(snap, ref e));
    CloseHandle(snap);
  }
  static bool IsShell(string n) { return n == "cmd.exe" || n == "powershell.exe" || n == "pwsh.exe" || n == "bash.exe" || n == "sh.exe" || n == "conhost.exe" || n.StartsWith("codex-command-runner") || n.StartsWith("codex-windows-sandbox"); }
  // The process whose exit means the agent is gone: the first ancestor that isn't a shell
  // wrapper. A hook's powershell.exe (Codex) or npm's cmd.exe shim exits right after the
  // hook, which must not close her early. 0 when unknown (then only her window matters).
  public static uint LivenessPid(uint pid) {
    var parent = new Dictionary<uint, uint>(); var exe = new Dictionary<uint, string>();
    Snapshot(parent, exe);
    var seen = new HashSet<uint>();
    for (int depth = 0; depth < 16 && pid != 0 && seen.Add(pid); depth++) {
      string name;
      if (!exe.TryGetValue(pid, out name) || name == "explorer.exe") return 0;
      if (!IsShell(name)) return pid;
      uint pp; if (!parent.TryGetValue(pid, out pp)) return 0;
      pid = pp;
    }
    return 0;
  }
  public static IntPtr AgentWindow(uint pid) {
    try { IntPtr c = ConsoleWindowOf(pid); if (c != IntPtr.Zero) return c; } catch { }
    var parent = new Dictionary<uint, uint>();
    var exe = new Dictionary<uint, string>();
    Snapshot(parent, exe);
    var wins = new List<KeyValuePair<uint, IntPtr>>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero || (GetWindowLong(h, -20) & 0x80) != 0) return true;
      RECT r; if (!GetWindowRect(h, out r) || r.Right - r.Left < 300 || r.Bottom - r.Top < 200) return true;
      uint p; GetWindowThreadProcessId(h, out p); wins.Add(new KeyValuePair<uint, IntPtr>(p, h)); return true;
    }, IntPtr.Zero);
    var seen = new HashSet<uint>();
    for (int depth = 0; depth < 16 && pid != 0 && seen.Add(pid); depth++) {
      string name; if (exe.TryGetValue(pid, out name) && name == "explorer.exe") break;   // the desktop, not an agent window
      foreach (var w in wins) if (w.Key == pid) return w.Value;
      uint pp; if (!parent.TryGetValue(pid, out pp)) break; pid = pp;
    }
    return IntPtr.Zero;
  }

  // Instant follow: Windows calls back on this (WPF) thread whenever the target window
  // moves or resizes, instead of the overlay polling its position.
  public delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc proc, uint pid, uint tid, uint flags);
  static WinEventProc keepAlive;   // the callback must not be garbage-collected
  public static event Action Moved;
  public static bool Follow(IntPtr target) {
    if (target == IntPtr.Zero) return false;
    uint pid; GetWindowThreadProcessId(target, out pid);
    keepAlive = (hook, ev, hwnd, idObject, idChild, thread, time) => {
      if (hwnd == target && idObject == 0) { var m = Moved; if (m != null) m(); }
    };
    // EVENT_OBJECT_LOCATIONCHANGE, out-of-context, only for the agent window's process.
    return SetWinEventHook(0x800B, 0x800B, IntPtr.Zero, keepAlive, pid, 0, 0) != IntPtr.Zero;
  }
}

// Gemini-chan's motion. She floats (a 6 px bob every 3.2 s and a 1 degree sway every 4.1 s),
// blinks at uneven gaps, moves her mouth while her line types out, and changes pose with a
// short crossfade and a small squash, never a hard cut. With Windows' animation setting
// off she is shown as still frames. Blink and talk frames are never shown whole: only
// their checked box (eyes, mouth; see tools/check-frames.mjs) is copied into the base
// frame, so nothing else on her can move or jump.
public static class AmkFigure {
  static Window win; static bool motion;
  static Image front, back; static TextBlock say; static ScaleTransform squash;
  static Run seen, rest;
  static readonly Dictionary<string, BitmapSource> cache = new Dictionary<string, BitmapSource>();
  static BitmapSource fBase, fBlink, fTalk, fWorking, fAlert;
  static string pose = "", text = null;
  static bool mouthOpen, blinking, typing, paused;
  static readonly Random rnd = new Random();
  static DispatcherTimer typeTimer, flapTimer, blinkTimer, blinkEnd;
  static List<string> parts = new List<string>(); static double[] at = new double[0]; static double typeEnd; static int shown;
  static readonly System.Diagnostics.Stopwatch clock = new System.Diagnostics.Stopwatch();
  public static Action<string> Log;   // a test harness may listen; the overlay itself never sets it
  const int Decode = 416;             // twice the 208 px picture: sharp up to 200% display scaling
  const string LongStop = "\u3002\uFF01\uFF1F\u2026\uFF5E!?.";
  const string ShortStop = "\uFF0C\u3001\uFF1B\uFF1A,;:\u2014";

  static void Note(string s) { var l = Log; if (l != null) { try { l(s); } catch { } } }
  static DispatcherTimer Timer(EventHandler tick) { var t = new DispatcherTimer(); t.Tick += tick; return t; }

  public static void Init(Window w, bool animate) {
    win = w; motion = animate;
    front = (Image)w.FindName("ArtA"); back = (Image)w.FindName("ArtB");
    say = (TextBlock)w.FindName("Say");
    var body = (FrameworkElement)w.FindName("Body");
    squash = new ScaleTransform(1, 1); body.RenderTransform = squash; body.RenderTransformOrigin = new Point(0.5, 1);
    // The untyped rest of the line is there but transparent, so the bubble keeps its size.
    seen = new Run(); rest = new Run(); rest.Foreground = Brushes.Transparent;
    say.Inlines.Clear(); say.Inlines.Add(seen); say.Inlines.Add(rest);
    typeTimer = Timer(TypeTick); flapTimer = Timer(FlapTick); blinkTimer = Timer(BlinkTick);
    blinkEnd = Timer(BlinkEndTick); blinkEnd.Interval = TimeSpan.FromMilliseconds(120);
    Stars((Canvas)w.FindName("Stars"));
    if (motion) { Float((FrameworkElement)w.FindName("Float")); NextBlink(); }
    Note("init motion=" + motion);
  }

  // Window fade-in, plus a short rise when motion is on.
  public static void Enter() {
    win.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(450)));
    if (!motion) return;
    var slide = new TranslateTransform(0, 30); ((FrameworkElement)win.FindName("Root")).RenderTransform = slide;
    var up = new DoubleAnimation(30, 0, TimeSpan.FromMilliseconds(560)); up.EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut };
    slide.BeginAnimation(TranslateTransform.YProperty, up);
  }

  // Round twinkling stars around her (never the 4-point sparkle of Google's Gemini mark).
  static void Stars(Canvas c) {
    double[][] stars = { new double[] { 184, 17, 7 }, new double[] { 197, 47, 5 }, new double[] { 154, 32, 4 }, new double[] { 14, 38, 5 }, new double[] { 18, 124, 4 }, new double[] { 191, 128, 5 } };
    for (int i = 0; i < stars.Length; i++) {
      var d = stars[i][2];
      var e = new Ellipse { Width = d, Height = d, Fill = new SolidColorBrush(Color.FromRgb(0xFF, 0xE9, 0xF6)), IsHitTestVisible = false };
      e.Effect = new DropShadowEffect { BlurRadius = 8, ShadowDepth = 0, Color = Colors.HotPink, Opacity = 0.9 };
      Canvas.SetLeft(e, stars[i][0] - d / 2); Canvas.SetTop(e, stars[i][1] - d / 2); c.Children.Add(e);
      if (!motion) continue;
      var tw = new DoubleAnimation(0.15, 1.0, TimeSpan.FromMilliseconds(700 + 230 * i)) { AutoReverse = true, RepeatBehavior = RepeatBehavior.Forever };
      Timeline.SetDesiredFrameRate(tw, 30);
      e.BeginAnimation(UIElement.OpacityProperty, tw);
    }
  }

  static void Float(FrameworkElement f) {
    var tilt = new RotateTransform(0); var bob = new TranslateTransform(0, 0);
    var g = new TransformGroup(); g.Children.Add(tilt); g.Children.Add(bob);
    f.RenderTransform = g; f.RenderTransformOrigin = new Point(0.5, 0.7);
    var ease = new SineEase { EasingMode = EasingMode.EaseInOut };
    var up = new DoubleAnimation(0, -6, TimeSpan.FromMilliseconds(1600)) { AutoReverse = true, RepeatBehavior = RepeatBehavior.Forever, EasingFunction = ease };
    var sway = new DoubleAnimation(-1, 1, TimeSpan.FromMilliseconds(2050)) { AutoReverse = true, RepeatBehavior = RepeatBehavior.Forever, EasingFunction = ease };
    Timeline.SetDesiredFrameRate(up, 30); Timeline.SetDesiredFrameRate(sway, 30);
    bob.BeginAnimation(TranslateTransform.YProperty, up);
    tilt.BeginAnimation(RotateTransform.AngleProperty, sway);
  }

  // From a stream, so non-ASCII paths need no URI escaping; decoded once at display size.
  static BitmapSource Load(string file) {
    if (string.IsNullOrEmpty(file) || !File.Exists(file)) return null;
    BitmapSource b;
    if (cache.TryGetValue(file, out b)) return b;
    using (var fs = File.OpenRead(file)) {
      var img = new BitmapImage();
      img.BeginInit(); img.CacheOption = BitmapCacheOption.OnLoad; img.StreamSource = fs; img.DecodePixelWidth = Decode; img.EndInit(); img.Freeze();
      var conv = new FormatConvertedBitmap(img, PixelFormats.Pbgra32, null, 0); conv.Freeze();
      b = conv;
    }
    cache[file] = b; return b;
  }
  static int PngWidth(string file) {
    using (var fs = File.OpenRead(file)) {
      var h = new byte[24];
      if (fs.Read(h, 0, 24) < 24 || h[1] != 0x50 || h[2] != 0x4E || h[3] != 0x47) return 0;
      return (h[16] << 24) | (h[17] << 16) | (h[18] << 8) | h[19];
    }
  }
  // The base with one box ("x0,y0,x1,y1" in full-size pixels) copied in from another frame.
  static BitmapSource Patch(string baseFile, string file, string box) {
    if (string.IsNullOrEmpty(file) || string.IsNullOrEmpty(box)) return null;
    string key = "patch|" + baseFile + "|" + file + "|" + box;
    BitmapSource done;
    if (cache.TryGetValue(key, out done)) return done;
    try {
      var b = Load(baseFile); var f = Load(file);
      int full = b == null || f == null ? 0 : PngWidth(baseFile);
      if (full <= 0 || full != PngWidth(file) || f.PixelWidth != b.PixelWidth || f.PixelHeight != b.PixelHeight) return null;
      var n = box.Split(',');
      if (n.Length != 4) return null;
      var inv = CultureInfo.InvariantCulture; double k = (double)b.PixelWidth / full;
      int x0 = (int)Math.Floor(int.Parse(n[0], inv) * k), y0 = (int)Math.Floor(int.Parse(n[1], inv) * k);
      int x1 = Math.Min(b.PixelWidth, (int)Math.Ceiling((int.Parse(n[2], inv) + 1) * k));
      int y1 = Math.Min(b.PixelHeight, (int)Math.Ceiling((int.Parse(n[3], inv) + 1) * k));
      if (x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0) return null;
      var rect = new Int32Rect(x0, y0, x1 - x0, y1 - y0);
      int stride = rect.Width * 4; var px = new byte[stride * rect.Height];
      f.CopyPixels(rect, px, stride, 0);
      var wb = new WriteableBitmap(b); wb.WritePixels(rect, px, stride, 0); wb.Freeze();
      cache[key] = wb; return wb;
    } catch { return null; }
  }

  // Poses: "working" while compaction runs, "alert" when the model check is suspect,
  // "base" otherwise (the only pose with blink and talk frames).
  public static void Show(string newPose, string line, string baseF, string blinkF, string blinkBox, string talkF, string talkBox, string workingF, string alertF) {
    try {
      fBase = Load(baseF); fWorking = Load(workingF); fAlert = Load(alertF);
      fBlink = Patch(baseF, blinkF, blinkBox); fTalk = Patch(baseF, talkF, talkBox);
    } catch { }
    Note("frames base=" + (fBase != null) + " blink=" + (fBlink != null) + " talk=" + (fTalk != null) + " working=" + (fWorking != null) + " alert=" + (fAlert != null));
    Say(newPose, line);
  }
  public static void Say(string newPose, string line) {
    newPose = newPose ?? ""; line = line ?? "";
    bool changed = newPose != pose || front.Source == null;
    pose = newPose;
    if (changed) ChangePose();
    if (changed || line != text) Type(line, changed && motion ? 200 : 0);
  }
  static bool BasePose() { return !(pose == "working" && fWorking != null) && !(pose == "alert" && fAlert != null); }
  static BitmapSource Current() {
    if (pose == "working" && fWorking != null) return fWorking;
    if (pose == "alert" && fAlert != null) return fAlert;
    if (blinking && fBlink != null) return fBlink;
    if (mouthOpen && fTalk != null) return fTalk;
    return fBase;
  }
  static void Refresh() { front.Source = Current(); }

  static void ChangePose() {
    mouthOpen = false; blinking = false; blinkEnd.Stop();
    var next = Current();
    Note("pose " + pose);
    if (!motion || front.Source == null) {
      front.BeginAnimation(UIElement.OpacityProperty, null); back.BeginAnimation(UIElement.OpacityProperty, null);
      front.Source = next; front.Opacity = 1; back.Source = null; back.Opacity = 0;
      return;
    }
    // The new pose fades in on the back layer, which then becomes the front one. The old
    // pose starts fading a moment later, so she never looks see-through halfway.
    var incoming = back; var outgoing = front;
    // Pin both start values: before its delayed start, the fade-out shows the plain value.
    incoming.BeginAnimation(UIElement.OpacityProperty, null); incoming.Opacity = 0;
    outgoing.BeginAnimation(UIElement.OpacityProperty, null); outgoing.Opacity = 1;
    incoming.Source = next;
    Panel.SetZIndex(incoming, 1); Panel.SetZIndex(outgoing, 0);
    incoming.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(180)));
    var fadeOut = new DoubleAnimation(1, 0, TimeSpan.FromMilliseconds(120)); fadeOut.BeginTime = TimeSpan.FromMilliseconds(60);
    outgoing.BeginAnimation(UIElement.OpacityProperty, fadeOut);
    front = incoming; back = outgoing;
    // Squash 4% (a touch wider), then settle back with a small overshoot.
    squash.BeginAnimation(ScaleTransform.ScaleYProperty, Squash(0.96));
    squash.BeginAnimation(ScaleTransform.ScaleXProperty, Squash(1.02));
  }
  static DoubleAnimationUsingKeyFrames Squash(double to) {
    var a = new DoubleAnimationUsingKeyFrames();
    a.KeyFrames.Add(new EasingDoubleKeyFrame(to, KeyTime.FromTimeSpan(TimeSpan.FromMilliseconds(90)), new QuadraticEase { EasingMode = EasingMode.EaseOut }));
    a.KeyFrames.Add(new EasingDoubleKeyFrame(1, KeyTime.FromTimeSpan(TimeSpan.FromMilliseconds(330)), new BackEase { EasingMode = EasingMode.EaseOut, Amplitude = 0.6 }));
    return a;
  }

  // Her line types out: wide (CJK) characters slower than narrow ones, a pause after
  // punctuation, and at most 2.2 s in all so there's time left to read it. Each character
  // has its own time on a stopwatch, so late timer ticks can't stretch the line.
  static void Type(string line, int delayMs) {
    typeTimer.Stop(); flapTimer.Stop(); typing = false; paused = false;
    if (mouthOpen) { mouthOpen = false; Refresh(); }
    text = line;
    if (!motion || line.Length == 0) { seen.Text = line; rest.Text = ""; Note("typed all"); return; }
    parts = new List<string>();
    var en = StringInfo.GetTextElementEnumerator(line);
    while (en.MoveNext()) parts.Add((string)en.Current);
    var gap = new double[parts.Count]; double total = 0;
    for (int i = 0; i < parts.Count; i++) { gap[i] = (parts[i][0] >= 0x2E80 ? 60 : 28) + Pause(i); total += gap[i]; }
    double k = total > 2200 ? 2200 / total : 1;
    at = new double[parts.Count]; double t = delayMs;
    for (int i = 0; i < parts.Count; i++) { at[i] = t; t += gap[i] * k; }
    typeEnd = t;
    shown = 0; seen.Text = ""; rest.Text = line; typing = true;
    clock.Restart(); typeTimer.Interval = TimeSpan.FromMilliseconds(15); typeTimer.Start();
    if (fTalk != null && BasePose()) { flapTimer.Interval = TimeSpan.FromMilliseconds(delayMs + 40); flapTimer.Start(); }
    Note("typing " + parts.Count + " in " + Math.Round(typeEnd) + "ms");
  }
  // A pause after the last mark of a run of punctuation.
  static int Pause(int i) {
    if (i + 1 < parts.Count && (LongStop.IndexOf(parts[i + 1][0]) >= 0 || ShortStop.IndexOf(parts[i + 1][0]) >= 0)) return 0;
    if (LongStop.IndexOf(parts[i][0]) >= 0) return 220;
    if (ShortStop.IndexOf(parts[i][0]) >= 0) return 120;
    return 0;
  }
  static void TypeTick(object s, EventArgs e) {
    try {
      double now = clock.Elapsed.TotalMilliseconds;
      int before = shown;
      while (shown < parts.Count && at[shown] <= now) shown++;
      if (shown != before) {
        seen.Text = string.Concat(parts.GetRange(0, shown)); rest.Text = string.Concat(parts.GetRange(shown, parts.Count - shown));
        // The mouth closes on punctuation and stays closed through the pause after it.
        char c = parts[shown - 1][0];
        paused = LongStop.IndexOf(c) >= 0 || ShortStop.IndexOf(c) >= 0;
        if (paused && mouthOpen) { mouthOpen = false; Refresh(); }
      }
      if (shown >= parts.Count && now >= typeEnd) { typeTimer.Stop(); EndTalk(); }
    } catch { typeTimer.Stop(); }
  }
  static void EndTalk() {
    typing = false; paused = false; flapTimer.Stop();
    if (mouthOpen) { mouthOpen = false; Refresh(); }
    Note("typed all");
  }
  // About 110 ms open, 110 ms closed, a little uneven.
  static void FlapTick(object s, EventArgs e) {
    try {
      if (!typing || fTalk == null || !BasePose()) { flapTimer.Stop(); return; }
      bool open = !paused && !blinking && !mouthOpen;
      if (open != mouthOpen) { mouthOpen = open; Refresh(); Note(open ? "mouth open" : "mouth closed"); }
      flapTimer.Interval = TimeSpan.FromMilliseconds(85 + rnd.Next(50));
    } catch { flapTimer.Stop(); }
  }

  // A 120 ms blink every 2.5 to 4.5 s, only in the base pose and with the mouth closed.
  static void NextBlink() { blinkTimer.Interval = TimeSpan.FromMilliseconds(2500 + rnd.Next(2001)); blinkTimer.Start(); }
  static void BlinkTick(object s, EventArgs e) {
    try {
      blinkTimer.Stop();
      if (fBlink == null || !BasePose()) { NextBlink(); return; }
      if (mouthOpen) { blinkTimer.Interval = TimeSpan.FromMilliseconds(150 + rnd.Next(200)); blinkTimer.Start(); return; }
      blinking = true; Refresh(); Note("blink"); blinkEnd.Start();
    } catch { }
  }
  static void BlinkEndTick(object s, EventArgs e) {
    try { blinkEnd.Stop(); blinking = false; Refresh(); NextBlink(); } catch { }
  }
}
