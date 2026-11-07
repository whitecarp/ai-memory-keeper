# AI Memory Keeper: Gemini-chan overlay, shown from the start of context compaction
# until it finishes (Windows). The hook rewrites the UTF-8 JSON data file; this
# window polls it: phase "working" keeps her on screen, phase "done" shows the
# result, then she fades out. ASCII only: display text comes from the data file.
# $DataFile, $NativeFile (overlay-native.cs) and $XamlFile (overlay.xaml) are
# prepended by overlay.mjs. Click-through, never takes focus. Any failure exits
# quietly with a local note. Her motion (float, blink, talking, pose changes) is
# AmkFigure in overlay-native.cs; it shows still frames when Windows' animation
# setting is off (or the data file says motion: false).
$ErrorActionPreference = 'Stop'
$alive = $DataFile + '.alive'
try {
  [IO.File]::WriteAllText($alive, [string]$PID)   # heartbeat: tells the hook this window is up
  Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Xaml
  Add-Type -Path $NativeFile -ReferencedAssemblies ([Windows.Window], [Windows.Media.Visual], [Windows.DependencyObject], [Xaml.XamlType] | % { $_.Assembly.Location })
  # DPI-aware before reading any coordinates, so the window rect and WPF agree
  # on physical pixels (otherwise she lands off-target on scaled displays).
  [void][AmkNative]::SetProcessDPIAware()
  $readData = { [IO.File]::ReadAllText($DataFile, [Text.Encoding]::UTF8) | ConvertFrom-Json }
  $data = & $readData
  $brush = { param($hex) (New-Object Windows.Media.BrushConverter).ConvertFromString($hex) }

  # Follow the agent's own window, not whatever happens to be in front.
  $target = [IntPtr]::Zero
  if ($data.agentPid) { $target = [AmkNative]::AgentWindow([uint32]$data.agentPid) }
  if ($target -eq [IntPtr]::Zero) { $target = [AmkNative]::GetForegroundWindow() }
  $targetRect = {
    if ($target -eq [IntPtr]::Zero -or -not [AmkNative]::IsWindow($target) -or [AmkNative]::IsIconic($target)) { return $null }
    $r = New-Object AmkNative+RECT
    if (-not [AmkNative]::GetWindowRect($target, [ref]$r)) { return $null }
    if (($r.Right - $r.Left) -lt 560 -or ($r.Bottom - $r.Top) -lt 380) { return $null }
    return $r
  }

  $window = [Windows.Markup.XamlReader]::Parse([IO.File]::ReadAllText($XamlFile, [Text.Encoding]::UTF8))
  $state = @{ seq = $null; done = $false; lastRect = ''; closing = $false; phase = '' }
  [AmkFigure]::Init($window, ([Windows.SystemParameters]::ClientAreaAnimation -and $data.motion -ne $false))

  $fade = New-Object Windows.Threading.DispatcherTimer
  $fade.Add_Tick({
    $fade.Stop()
    $out = New-Object Windows.Media.Animation.DoubleAnimation(1, 0, [TimeSpan]::FromMilliseconds(600))
    $out.Add_Completed({ $window.Close() })
    $window.BeginAnimation([Windows.UIElement]::OpacityProperty, $out)
  })
  # Safety caps. Working: leave after 5 minutes if compaction never finishes. Saving (after
  # compaction): wait for the background save at most saveCapMs, then say when the memories
  # will arrive. The guard closes the window whatever happens.
  $cap = New-Object Windows.Threading.DispatcherTimer; $cap.Interval = [TimeSpan]::FromMinutes(5)
  $cap.Add_Tick({ $cap.Stop(); if (-not $state.done) { $state.done = $true; $fade.Interval = [TimeSpan]::FromMilliseconds(10); $fade.Start() } })
  $guard = New-Object Windows.Threading.DispatcherTimer; $guard.Interval = [TimeSpan]::FromMinutes(6)
  $guard.Add_Tick({ $guard.Stop(); $window.Close() })
  $saveCap = New-Object Windows.Threading.DispatcherTimer
  $saveCap.Add_Tick({
    $saveCap.Stop()
    if ($state.phase -ne 'saving' -or $state.closing) { return }
    $state.done = $true
    try { $d = & $readData; if ([string]$d.lateSay) { [AmkFigure]::Say('base', [string]$d.lateSay) } } catch {}
    $window.FindName('PartnerBox').Visibility = 'Collapsed'
    $fade.Stop(); $fade.Interval = [TimeSpan]::FromMilliseconds(5850); $fade.Start()
  })

  $apply = {
    param($d)
    $state.seq = [string]$d.seq
    $f = $d.frames
    [AmkFigure]::Show([string]$d.pose, [string]$d.say, [string]$f.base, [string]$f.blink, [string]$f.blinkBox, [string]$f.talk, [string]$f.talkBox, [string]$f.working, [string]$f.alert)
    $window.FindName('Name').Text = [string]$d.name
    $window.FindName('Credit').Text = [string]$d.credit
    $box = $window.FindName('PartnerBox')
    if ($d.partner) {
      $colors = @{ ok = '#95F0C8'; notice = '#FFD27A'; suspect = '#FF9FB0'; pending = '#AEB5DE' }
      $c = $colors[[string]$d.partner.level]; if (-not $c) { $c = '#EEF0FF' }
      $p = $window.FindName('Partner')
      $p.Text = ([string][char]0x25CF) + ' ' + [string]$d.partner.text
      $p.Foreground = & $brush $c
      $box.Visibility = 'Visible'
    } else { $box.Visibility = 'Collapsed' }
    $ph = [string]$d.phase
    if ($ph -eq 'saving' -and $state.phase -ne 'saving') {
      # Compaction is over and the save is still running: wait for it, at most saveCapMs.
      $cap.Stop()
      $ms = [int]$d.saveCapMs; if ($ms -lt 10000 -or $ms -gt 600000) { $ms = 120000 }
      $saveCap.Interval = [TimeSpan]::FromMilliseconds($ms); $saveCap.Start()
      $guard.Stop(); $guard.Interval = [TimeSpan]::FromMilliseconds($ms + 60000); $guard.Start()
    }
    if ($ph -eq 'done' -and -not $state.closing) {
      # The result: hold it for a moment, then fade out. A newer result restarts the hold.
      $saveCap.Stop()
      $state.done = $true
      $hold = [int]$d.durationMs; if ($hold -lt 2000 -or $hold -gt 20000) { $hold = 6500 }
      $fade.Stop(); $fade.Interval = [TimeSpan]::FromMilliseconds($hold - 650); $fade.Start()
    }
    $state.phase = $ph
  }
  & $apply $data

  # Never take focus, let clicks pass through, stay out of Alt+Tab.
  $window.Add_SourceInitialized({
    $h = (New-Object Windows.Interop.WindowInteropHelper($window)).Handle
    $ex = [AmkNative]::GetWindowLong($h, -20)
    [void][AmkNative]::SetWindowLong($h, -20, ($ex -bor 0x08000000 -bor 0x00000020 -bor 0x00000080))
  })
  # Bottom-right corner of the agent's window (or of the screen if it can't be found).
  $place = {
    $r = & $targetRect
    $m = [Windows.PresentationSource]::FromVisual($window).CompositionTarget.TransformFromDevice
    if ($r) { $br = $m.Transform((New-Object Windows.Point($r.Right, $r.Bottom))); $right = $br.X - 12; $bottom = $br.Y - 8; $state.lastRect = "$($r.Left),$($r.Top),$($r.Right),$($r.Bottom)" }
    else { $wa = [Windows.SystemParameters]::WorkArea; $right = $wa.Right - 4; $bottom = $wa.Bottom - 2 }
    $window.Left = $right - $window.ActualWidth; $window.Top = $bottom - $window.ActualHeight
  }
  $window.Add_Loaded({
    & $place
    # Move with the agent window the moment it moves (the poll below is only a fallback).
    try {
      [AmkNative]::add_Moved([Action]{ try { if (-not [AmkNative]::IsIconic($target)) { & $place } } catch {} })
      [void][AmkNative]::Follow($target)
    } catch {}
    [AmkFigure]::Enter()
  })
  # Keep the corner anchored when the text changes size.
  $window.Add_SizeChanged({ param($sender, $e) if ($e.HeightChanged -and $window.Top -gt -5000) { & $place } })

  # Leave when there is nothing to stay for: the agent's window closed, the agent exited,
  # or compaction failed and the user has already moved on (a new prompt in the transcript).
  $closeNow = { if (-not $state.closing) { $state.closing = $true; $state.done = $true; $fade.Stop(); $fade.Interval = [TimeSpan]::FromMilliseconds(10); $fade.Start() } }
  $agentPid = [int]$data.agentPid
  $agentProc = $null
  if ($agentPid -gt 0) { try { $live = [AmkNative]::LivenessPid([uint32]$agentPid); if ($live -gt 0) { $agentProc = [Diagnostics.Process]::GetProcessById([int]$live) } } catch { $agentProc = $null } }
  $tx = @{ path = [string]$data.transcript; offset = -1; rest = '' }
  if ($tx.path -and (Test-Path -LiteralPath $tx.path)) { $tx.offset = (Get-Item -LiteralPath $tx.path).Length }
  $newHumanPrompt = {
    if ($tx.offset -lt 0) { return $false }
    $len = (Get-Item -LiteralPath $tx.path).Length
    if ($len -le $tx.offset) { return $false }
    $fs2 = New-Object IO.FileStream($tx.path, 'Open', 'Read', 'ReadWrite')
    try { [void]$fs2.Seek($tx.offset, 'Begin'); $buf = New-Object byte[] ($len - $tx.offset); $n = $fs2.Read($buf, 0, $buf.Length) } finally { $fs2.Dispose() }
    $tx.offset += $n
    $chunk = $tx.rest + [Text.Encoding]::UTF8.GetString($buf, 0, $n)
    $parts = $chunk -split "`n"; $tx.rest = $parts[-1]
    if ($parts.Count -lt 2) { return $false }
    foreach ($ln in $parts[0..($parts.Count - 2)]) {
      try {
        $r = $ln | ConvertFrom-Json
        # A typed prompt, not slash-command markup, injected context or a compaction summary.
        $txt = $null
        if ($r.type -eq 'user' -and $r.message.content -is [string] -and -not $r.isMeta -and -not $r.isCompactSummary) { $txt = $r.message.content }
        if ($r.type -eq 'response_item' -and $r.payload.role -eq 'user' -and $r.payload.type -eq 'message') { $txt = [string]$r.payload.content[0].text }
        if ($txt -and -not $txt.TrimStart().StartsWith('<')) { return $true }
      } catch {}
    }
    return $false
  }
  $failed = {
    $state.done = $true
    [AmkFigure]::Say('base', [string]$data.failSay)
    $window.FindName('PartnerBox').Visibility = 'Collapsed'
    $fade.Stop(); $fade.Interval = [TimeSpan]::FromMilliseconds(4500); $fade.Start()
  }

  # Poll: heartbeat for the hook, follow the agent window, pick up the "done" update.
  $poll = New-Object Windows.Threading.DispatcherTimer; $poll.Interval = [TimeSpan]::FromMilliseconds(400)
  $poll.Add_Tick({
    try { [IO.File]::WriteAllText($alive, [string]$PID) } catch {}
    try {
      if ($target -ne [IntPtr]::Zero -and -not [AmkNative]::IsWindow($target)) { & $closeNow; return }
      if ($agentProc -and $agentProc.HasExited) { & $closeNow; return }
    } catch {}
    # Only while compacting: after it, a new prompt is just the user moving on.
    try { if ($state.phase -eq 'working' -and -not $state.done -and [string]$data.failSay -and (& $newHumanPrompt)) { & $failed } } catch {}
    try {
      if ($target -ne [IntPtr]::Zero) {
        if ([AmkNative]::IsIconic($target)) { if ($window.Visibility -eq 'Visible') { $window.Visibility = 'Hidden' } }
        else {
          if ($window.Visibility -ne 'Visible') { $window.Visibility = 'Visible' }
          $r = & $targetRect
          if ($r -and "$($r.Left),$($r.Top),$($r.Right),$($r.Bottom)" -ne $state.lastRect) { & $place }
        }
      }
    } catch {}
    try { $d = & $readData; if ([string]$d.seq -ne $state.seq) { & $apply $d } } catch {}
  })
  $window.Add_Closed({
    $poll.Stop()
    try { [IO.File]::Delete($alive) } catch {}
    $window.Dispatcher.InvokeShutdown()
  })

  $window.Show(); $poll.Start()
  # Never linger if the "done" signal never comes (failed compaction).
  if ($state.phase -eq 'working') { $cap.Start() }
  if (-not $guard.IsEnabled) { $guard.Start() }
  [Windows.Threading.Dispatcher]::Run()
} catch {
  # Leave a local note for diagnosis (no transcript text lives in this script), then exit quietly.
  try { [IO.File]::WriteAllText($DataFile + '.error.txt', ($_ | Out-String) + "`n" + $_.ScriptStackTrace, [Text.Encoding]::UTF8) } catch {}
  try { [IO.File]::Delete($alive) } catch {}
  exit 0
}
