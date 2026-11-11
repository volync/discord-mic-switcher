<#
  Mic Switcher - autostart for the Discord desktop app (Windows).
  Copyright (c) 2026 volync. All rights reserved.
  Source-available, personal non-commercial use only - see LICENSE.
  Official source: https://github.com/volync/discord-mic-switcher
  SPDX-License-Identifier: LicenseRef-MicSwitcher-SAL-1.0

  1. HOOK: adds a small block to Discord's startup file
       %LOCALAPPDATA%\Discord\app-*\modules\discord_desktop_core-*\discord_desktop_core\index.js
     On every Discord start or reload (Ctrl+R) it reads mic-switcher.js from THIS folder and
     runs it in the Discord window, the same as pasting it in the console.

  2. UPDATE GUARD: Discord updates install a fresh copy of that startup file, which drops the
     hook. Updates usually happen on the "Checking for updates" splash, before the startup file
     loads. So a small background guard starts with Windows and watches the Discord folder.
     When an update writes a new startup file, the guard puts the hook back within about a
     second, before Discord loads it. As a backup it also re-checks every 60 seconds.
     It uses no CPU while idle.

  Works next to Vencord, which patches resources\app.asar, not this file.

  Usage
    .\install-autostart.ps1              install the hook + update guard (recommended)
    .\install-autostart.ps1 -NoGuard     install the hook only (re-run after every Discord update)
    .\install-autostart.ps1 -Uninstall   remove the hook and the guard
    (-Guard is the mode Windows runs at logon; you never need to run it yourself.)

  Guard log: %LOCALAPPDATA%\MicSwitcher\autostart-guard.log
#>
param([switch]$Uninstall, [switch]$NoGuard, [switch]$Guard)
$ErrorActionPreference = 'Stop'

$BEGIN   = '// [MicSwitcher autostart]'
$END     = '// [/MicSwitcher autostart]'
$RunKey  = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$RunName = 'MicSwitcherAutostartGuard'
$roots   = @("$env:LOCALAPPDATA\Discord", "$env:LOCALAPPDATA\DiscordPTB", "$env:LOCALAPPDATA\DiscordCanary")
$logDir  = Join-Path $env:LOCALAPPDATA 'MicSwitcher'
$logFile = Join-Path $logDir 'autostart-guard.log'
$self    = $PSCommandPath
$utf8    = New-Object System.Text.UTF8Encoding $false
$blockRegex = '(?s)' + [regex]::Escape($BEGIN) + '.*?' + [regex]::Escape($END) + '\r?\n?'
$scriptFile = Join-Path $PSScriptRoot 'mic-switcher.js'
$jsPath     = $scriptFile -replace '\\', '/'
$guardArgs  = @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', "`"$self`"", '-Guard')
$guardCmd   = 'powershell.exe ' + ($guardArgs -join ' ')

# The hook. It runs in Discord's main (Node) process and only injects into Discord pages,
# skipping pop-out and overlay windows.
$hook = @'
// [MicSwitcher autostart]  Remove with install-autostart.ps1 -Uninstall
try {
  const { app } = require('electron');
  const fs = require('fs');
  const SCRIPT = '__SCRIPT_PATH__';
  const isMainPage = (url) => /^https:\/\/(canary\.|ptb\.)?discord\.com\//.test(url) && !/popout|overlay/i.test(url);
  app.on('browser-window-created', (_e, win) => {
    const wc = win.webContents;
    wc.on('dom-ready', () => {
      if (!isMainPage(wc.getURL())) return;
      let code;
      try { code = fs.readFileSync(SCRIPT, 'utf8'); } catch (e) { console.error('[MicSwitcher] cannot read ' + SCRIPT, e); return; }
      wc.executeJavaScript('window.__MIC_SWITCHER_AUTOLOAD__ = true;\n' + code + '\n//# sourceURL=mic-switcher.js')
        .catch((e) => console.error('[MicSwitcher] inject failed', e));
    });
  });
} catch (e) { console.error('[MicSwitcher] autostart hook failed', e); }
// [/MicSwitcher autostart]
'@ -replace '__SCRIPT_PATH__', $jsPath

# Every Discord startup file of every installed version (old app-* folders are harmless to patch).
function Get-Targets {
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        foreach ($app in Get-ChildItem $root -Directory -Filter 'app-*' -ErrorAction SilentlyContinue) {
            $mods = Join-Path $app.FullName 'modules'
            if (-not (Test-Path $mods)) { continue }
            foreach ($core in Get-ChildItem $mods -Directory -Filter 'discord_desktop_core-*' -ErrorAction SilentlyContinue) {
                $f = Join-Path $core.FullName 'discord_desktop_core\index.js'
                if (Test-Path $f) { $f }
            }
        }
    }
}

# Returns 'patched', 'ok' (current hook already there) or 'skipped' (not Discord's loader / still being written).
function Set-Hook([string]$file) {
    $text = [IO.File]::ReadAllText($file)
    if ($text.Contains($hook)) { return 'ok' }
    $clean = [regex]::Replace($text, $blockRegex, '')            # drop an older copy of our hook
    if ($clean -notmatch 'core\.asar') { return 'skipped' }
    $backup = "$file.micswitcher-backup"
    if (-not (Test-Path $backup)) { [IO.File]::WriteAllText($backup, $clean, $utf8) }
    [IO.File]::WriteAllText($file, $hook + "`n" + $clean, $utf8)  # everything else (other mods) stays untouched
    return 'patched'
}

function Remove-Hook([string]$file) {
    $text = [IO.File]::ReadAllText($file)
    $clean = [regex]::Replace($text, $blockRegex, '')
    if ($clean -eq $text) { return $false }
    [IO.File]::WriteAllText($file, $clean, $utf8)
    return $true
}

function Write-GuardLog([string]$msg) {
    try {
        if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force $logDir | Out-Null }
        if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 200KB) { Remove-Item $logFile -Force }
        Add-Content -Path $logFile -Value ('{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $msg) -Encoding UTF8
    } catch { }
}

function Get-GuardProcesses {
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($self) -and $_.CommandLine -match '\s-Guard\b' -and $_.ProcessId -ne $PID }
}

# ---------------------------------------------------------------- guard mode (runs in background)
if ($Guard) {
    $ErrorActionPreference = 'Continue'
    $mutex = New-Object System.Threading.Mutex($false, 'Local\MicSwitcherAutostartGuard')
    if (-not $mutex.WaitOne(0)) { exit }                          # another guard is already running

    function Invoke-Scan {
        foreach ($f in Get-Targets) {
            try { if ((Set-Hook $f) -eq 'patched') { Write-GuardLog "hook re-applied: $f" } }
            catch { }                                             # file busy (update still writing) - next event/scan retries
        }
    }

    Write-GuardLog "guard started (pid $PID), watching: $(($roots | Where-Object { Test-Path $_ }) -join ', ')"
    Invoke-Scan
    $n = 0
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        $w = New-Object System.IO.FileSystemWatcher $root
        $w.IncludeSubdirectories = $true
        $w.InternalBufferSize = 65536
        $w.NotifyFilter = [System.IO.NotifyFilters]'FileName, DirectoryName'   # new/renamed files+folders only, not log writes
        foreach ($evt in 'Created', 'Renamed') {
            Register-ObjectEvent -InputObject $w -EventName $evt -SourceIdentifier "msw-guard-$n" | Out-Null
            $n++
        }
        $w.EnableRaisingEvents = $true
    }

    # PowerShell idles at ~100 MB; give the unused pages back to Windows (cosmetic, but keeps the guard light).
    function Invoke-Trim {
        try {
            [GC]::Collect(); [GC]::WaitForPendingFinalizers()
            $me = [Diagnostics.Process]::GetCurrentProcess()
            $me.MaxWorkingSet = $me.MaxWorkingSet                 # SetProcessWorkingSetSize -> trims the working set
        } catch { }
    }
    Invoke-Trim

    while ($true) {
        try {
            $e = Wait-Event -Timeout 60                           # wakes on a new file/folder, or every 60 s
            if ($e) {
                Start-Sleep -Milliseconds 300                     # let a burst of update writes settle
                $paths = @(Get-Event | ForEach-Object {
                    $p = "$($_.SourceEventArgs.FullPath)"
                    Remove-Event -EventIdentifier $_.EventIdentifier
                    $p
                })
                if (-not ($paths | Where-Object { $_ -match 'discord_desktop_core|\\app-[\d.]+$|\\modules$' })) { continue }
            }
            Invoke-Scan
            Invoke-Trim
        } catch { Start-Sleep -Seconds 5 }
    }
}

# ---------------------------------------------------------------- uninstall
if ($Uninstall) {
    Remove-ItemProperty -Path $RunKey -Name $RunName -ErrorAction SilentlyContinue
    foreach ($p in @(Get-GuardProcesses)) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Host "Stopped update guard (pid $($p.ProcessId))"
    }
    $removed = 0
    foreach ($f in Get-Targets) {
        if (Remove-Hook $f) { Write-Host "Removed:    $f" -ForegroundColor Yellow; $removed++ }
    }
    if ($removed -eq 0) { Write-Host 'No hook was installed.' }
    Write-Host ''
    Write-Host 'Done. Fully quit Discord (tray icon > Quit Discord) and start it again.' -ForegroundColor Cyan
    exit
}

# ---------------------------------------------------------------- install
if (-not (Test-Path $scriptFile)) { throw "mic-switcher.js not found next to this installer ($PSScriptRoot)." }
$targets = @(Get-Targets)
if (-not $targets) { throw 'No Discord installation found (looked in %LOCALAPPDATA%\Discord, DiscordPTB, DiscordCanary).' }

foreach ($f in $targets) {
    switch (Set-Hook $f) {
        'patched' { Write-Host "Installed:  $f" -ForegroundColor Green }
        'ok'      { Write-Host "Up to date: $f" }
        'skipped' { Write-Host "Skipped (unexpected file content): $f" -ForegroundColor Yellow }
    }
}
Write-Host "Script:     $jsPath"

if ($NoGuard) {
    Write-Host 'Update guard NOT installed - re-run this installer after every Discord update.' -ForegroundColor Yellow
} else {
    Set-ItemProperty -Path $RunKey -Name $RunName -Value $guardCmd       # start with Windows
    foreach ($p in @(Get-GuardProcesses)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList $guardArgs   # and start it right now
    Write-Host 'Update guard: running, starts with Windows, and re-applies the hook after Discord updates.' -ForegroundColor Green
}

Write-Host ''
if (Get-Process -Name Discord, DiscordPTB, DiscordCanary -ErrorAction SilentlyContinue) {
    Write-Host 'Discord is running. Fully quit it (tray icon > Quit Discord) and start it again.' -ForegroundColor Cyan
} else {
    Write-Host 'Done. Start Discord.' -ForegroundColor Cyan
}
