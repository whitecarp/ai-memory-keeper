# AI Memory Keeper: the window where the person pastes their Gemini API key (Windows).
# The key is encrypted at once with DPAPI for the current Windows user and written to
# $KeyFile; it is never printed, logged or passed on a command line. Then `amk key-check`
# (which reads the stored key itself) tries one tiny made-up request and answers in plain
# words; a key Google rejects is removed again. Display text comes from the UTF-8
# $DataFile. $ResultFile gets saved, rejected or cancelled (never the key).
# $DataFile, $XamlFile, $KeyFile, $ResultFile, $Entropy, $NodeExe, $CliFile, $KeeperHome,
# $KeyLang and $KeyKind (studio: AI Studio key; cloud: Agent Platform key) are prepended by key.mjs.
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
  $open = { param($u) if ($u -like 'https://aistudio.google.com/*' -or $u -like 'https://docs.cloud.google.com/*') { Start-Process $u } }
  $w.FindName('GetKey').Add_Click({ & $open ([string]$t.keyPage) })
  $w.FindName('Regions').Add_Click({ & $open ([string]$t.regionsPage) })
  $save = $w.FindName('Save'); $cancel = $w.FindName('Cancel'); $pick = $w.FindName('PickJson')
  $save.Content = [string]$t.save; $cancel.Content = [string]$t.cancel
  if ($pick -and $t.pickJson) { $pick.Content = [string]$t.pickJson } elseif ($pick) { $pick.Visibility = 'Collapsed' }
  $box = $w.FindName('Key'); $note = $w.FindName('Note')
  $state = @{ result = 'cancelled'; proc = $null; started = $null }
  $done = New-Object Windows.Threading.DispatcherTimer; $done.Interval = [TimeSpan]::FromMilliseconds(1600)
  $done.Add_Tick({ $done.Stop(); $w.Close() })
  $poll = New-Object Windows.Threading.DispatcherTimer; $poll.Interval = [TimeSpan]::FromMilliseconds(300)
  $poll.Add_Tick({
    $p = $state.proc
    if (-not $p) { $poll.Stop(); return }
    if (-not $p.HasExited) {
      if (((Get-Date) - $state.started).TotalSeconds -gt 30) { $poll.Stop(); $note.Text = [string]$t.slow }
      return
    }
    $poll.Stop()
    $r = $null
    try { $r = $p.StandardOutput.ReadToEnd() | ConvertFrom-Json } catch {}
    if ($r -and $r.ok) {
      $state.result = 'saved'; $note.Foreground = & $brush '#95F0C8'; $note.Text = [string]$r.reason; $done.Start()
    } elseif ($r -and -not $r.kept) {
      $state.result = 'rejected'; $note.Text = [string]$r.reason
      $save.IsEnabled = $true; $box.IsEnabled = $true; if ($pick) { $pick.IsEnabled = $true }; [void]$box.Focus()
    } else {
      $state.result = 'saved'; $note.Text = $(if ($r) { [string]$r.reason } else { [string]$t.slow })
    }
  })
  $normalize = {
    param($raw)
    $s = [string]$raw
    if ($null -eq $s) { return $null }
    $s = $s.Trim()
    if ($s.StartsWith('{') -and $s.EndsWith('}')) {
      try {
        $j = $s | ConvertFrom-Json
        if ($j.type -eq 'service_account' -and $j.project_id -and $j.client_email -and ([string]$j.private_key).Contains('BEGIN PRIVATE KEY')) {
          return (@{ type = 'service_account'; project_id = [string]$j.project_id; client_email = [string]$j.client_email; private_key = [string]$j.private_key; token_uri = 'https://oauth2.googleapis.com/token' } | ConvertTo-Json -Compress)
        }
      } catch {}
    }
    if ($s -match '^[\x21-\x7e]{20,200}$') { return $s }
    return $null
  }
  $commitKey = {
    param($raw)
    $k = & $normalize $raw
    if (-not $k) { $note.Text = [string]$t.invalid; return }
    $enc = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($k), [Text.Encoding]::UTF8.GetBytes($Entropy), 'CurrentUser')
    $k = $null
    $tmp = $KeyFile + '.tmp'
    [IO.File]::WriteAllBytes($tmp, $enc)
    Move-Item -LiteralPath $tmp -Destination $KeyFile -Force
    $box.Clear(); $state.result = 'saved'
    $save.IsEnabled = $false; $box.IsEnabled = $false; if ($pick) { $pick.IsEnabled = $false }; $cancel.Content = [string]$t.close
    $note.Foreground = & $brush '#FFD27A'; $note.Text = [string]$t.checking
    # The check reads the stored key itself: nothing secret on this command line.
    $psi = New-Object Diagnostics.ProcessStartInfo($NodeExe)
    $psi.Arguments = '"' + $CliFile + '" key-check --home "' + $KeeperHome + '" --lang ' + $KeyLang
    if ($KeyKind -eq 'cloud') { $psi.Arguments += ' --cloud' }
    $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.CreateNoWindow = $true
    $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
    $state.started = Get-Date
    $state.proc = [Diagnostics.Process]::Start($psi)
    $poll.Start()
  }
  $save.Add_Click({ & $commitKey $box.Password })
  if ($pick) {
    $pick.Add_Click({
      $dlg = New-Object Microsoft.Win32.OpenFileDialog
      $dlg.Filter = 'JSON (*.json)|*.json'
      if ($dlg.ShowDialog() -eq $true) {
        try { & $commitKey ([IO.File]::ReadAllText($dlg.FileName, [Text.Encoding]::UTF8)) } catch { $note.Text = [string]$t.invalid }
      }
    })
  }
  $w.Add_ContentRendered({ [void]$w.Activate(); [void]$box.Focus() })
  [void]$w.ShowDialog()
  [IO.File]::WriteAllText($ResultFile, $state.result)
} catch {
  try { [IO.File]::WriteAllText($ResultFile, 'error') } catch {}
  exit 1
}
