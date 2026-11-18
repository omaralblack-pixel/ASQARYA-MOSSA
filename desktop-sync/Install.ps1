$ErrorActionPreference = 'Stop'
$destination = Join-Path $env:LOCALAPPDATA 'Programs\SAPDesktopSync'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'SAPDesktopSync.exe') (Join-Path $destination 'SAPDesktopSync.exe') -Force
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'SAP Desktop Sync.lnk'))
$shortcut.TargetPath = Join-Path $destination 'SAPDesktopSync.exe'
$shortcut.WorkingDirectory = $destination
$shortcut.Save()
Start-Process $shortcut.TargetPath
