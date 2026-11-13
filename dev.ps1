$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (Get-Process -Name zotero -ErrorAction SilentlyContinue) {
    throw "Close Zotero before starting the development instance."
}

& npm.cmd start
if ($LASTEXITCODE -ne 0) {
    throw "Development server exited with code $LASTEXITCODE."
}
