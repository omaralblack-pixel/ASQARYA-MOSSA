$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
py -3.12 -m venv .venv
if ($LASTEXITCODE -ne 0) { throw 'Install Python 3.12 x64 first.' }
& .\.venv\Scripts\python.exe -m pip install --disable-pip-version-check pyinstaller==6.16.0
if ($LASTEXITCODE -ne 0) { throw 'PyInstaller installation failed.' }
& .\.venv\Scripts\python.exe -m unittest discover -s tests -v
if ($LASTEXITCODE -ne 0) { throw 'Tests failed.' }
& .\.venv\Scripts\python.exe -m PyInstaller --noconfirm --clean --onefile --windowed --name SAPDesktopSync app.py
if ($LASTEXITCODE -ne 0) { throw 'EXE build failed.' }
$smoke = Start-Process -FilePath (Join-Path $PSScriptRoot 'dist\SAPDesktopSync.exe') -ArgumentList '--self-test' -Wait -PassThru
if ($smoke.ExitCode -ne 0) { throw 'Packaged EXE smoke test failed.' }
Copy-Item Install.ps1 dist\Install.ps1 -Force
Copy-Item README.ar.md dist\README.ar.md -Force
Get-FileHash dist\SAPDesktopSync.exe -Algorithm SHA256 | Format-List
Write-Host 'Built: desktop-sync\dist\SAPDesktopSync.exe'
