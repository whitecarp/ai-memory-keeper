# AI Memory Keeper: the window where the person pastes their Gemini API key (Windows).
# The key is encrypted at once with DPAPI for the current Windows user and written to
# $KeyFile; it is never printed, logged or passed on a command line. Then `amk key-check`
# (which reads the stored key itself) tries one tiny made-up request and answers in plain
# words; a key Google rejects is removed again. Display text comes from the UTF-8
# $DataFile. $ResultFile gets saved, rejected or cancelled (never the key).
# $DataFile, $XamlFile, $KeyFile, $ResultFile, $Entropy, $NodeExe, $CliFile, $KeeperHome
# and $KeyLang are prepended by key.mjs.
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Security
  $t = [IO.File]::ReadAllText($DataFile, [Text.Encoding]::UTF8) | ConvertFrom-Json
  $w = [Windows.Markup.XamlReader]::Parse([IO.File]::ReadAllText($XamlFile, [Text.Encoding]::UTF8))
  $brush = { param($hex) (New-Object Windows.Media.BrushConverter).ConvertFromString($hex) }
  $w.Title = [string]$t.title
  $w.FindName('Head').Text = [string]$t.head
  $w.FindName('Body').Text = [string]$t.body
  $w.FindName('GetKeyText').Text = [string]$t.getKey
  $w.FindName('Rules').Text = [string]$t.rules + ' '
  $w.FindName('RegionsText').Text = [string]$t.regions
  # Only Google's own pages, fixed in key.mjs.
  $open = { param($u) if ($u -like 'https://aistudio.google.com/*') { Start-Process $u } }
  $w.FindName('GetKey').Add_Click({ & $open ([string]$t.keyPage) })
  $w.FindName('Regions').Add_Click({ & $open ([string]$t.regionsPage) })
  $save = $w.FindName('Save'); $cancel = $w.FindName('Cancel')
  $save.Content = [string]$t.save; $cancel.Content = [string]$t.cancel
  $box = $w.FindName('Key'); $note = $w.FindName('Note')
  $state = @{ result = 'cancelled'; proc = $null; started = $null }
  $done = New-Object Windows.Threading.DispatcherTimer; $done.Interval = [TimeSpan]::FromMilliseconds(1600)
  $done.Add_Tick({ $done.Stop(); $w.Close() })
  $poll = New-Object Windows.Threading.DispatcherTimer; $poll.Interval = [TimeSpan]::FromMilliseconds(300)
  $poll.Add_Tick({
    $p = $state.proc
    if (-not $p) { $poll.Stop(); return }
    if (-not $p.HasExited) {
      if (((Get-Date) - $state.started).TotalSeconds -gt 40) { $poll.Stop(); $note.Text = [string]$t.slow }
      return
    }
    $poll.Stop()
    $r = $null
    try { $r = $p.StandardOutput.ReadToEnd() | ConvertFrom-Json } catch {}
    if ($r -and $r.ok) {
      $state.result = 'saved'; $note.Foreground = & $brush '#95F0C8'; $note.Text = [string]$r.reason; $done.Start()
    } elseif ($r -and -not $r.kept) {
      $state.result = 'rejected'; $note.Text = [string]$r.reason
      $save.IsEnabled = $true; $box.IsEnabled = $true; [void]$box.Focus()
    } else {
      $state.result = 'saved'; $note.Text = $(if ($r) { [string]$r.reason } else { [string]$t.slow })
    }
  })
  $save.Add_Click({
    $k = $box.Password.Trim()
    if ($k -notmatch '^[\x21-\x7e]{20,200}$') { $note.Text = [string]$t.invalid; return }
    $enc = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($k), [Text.Encoding]::UTF8.GetBytes($Entropy), 'CurrentUser')
    $k = $null
    $tmp = $KeyFile + '.tmp'
    [IO.File]::WriteAllBytes($tmp, $enc)
    Move-Item -LiteralPath $tmp -Destination $KeyFile -Force
    $box.Clear(); $state.result = 'saved'
    $save.IsEnabled = $false; $box.IsEnabled = $false; $cancel.Content = [string]$t.close
    $note.Foreground = & $brush '#FFD27A'; $note.Text = [string]$t.checking
    # The check reads the stored key itself: nothing secret on this command line.
    $psi = New-Object Diagnostics.ProcessStartInfo($NodeExe)
    $psi.Arguments = '"' + $CliFile + '" key-check --home "' + $KeeperHome + '" --lang ' + $KeyLang
    $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.CreateNoWindow = $true
    $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
    $state.started = Get-Date
    $state.proc = [Diagnostics.Process]::Start($psi)
    $poll.Start()
  })
  $w.Add_ContentRendered({ [void]$w.Activate(); [void]$box.Focus() })
  [void]$w.ShowDialog()
  [IO.File]::WriteAllText($ResultFile, $state.result)
} catch {
  try { [IO.File]::WriteAllText($ResultFile, 'error') } catch {}
  exit 1
}
