param([switch]$UnsignedTest)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Python = Join-Path $Root ".venv-build\Scripts\python.exe"
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$NpmCli = Join-Path (Split-Path -Parent $Node) "node_modules\npm\bin\npm-cli.js"

if (-not (Test-Path -LiteralPath $NpmCli)) {
    throw "npm tidak ditemukan pada instalasi Node.js: $NpmCli"
}

function Invoke-Npm {
    & $Node $NpmCli @args
    if ($LASTEXITCODE -ne 0) { throw "Perintah npm gagal: npm $args" }
}

function Get-IntegritySha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ([System.IO.Path]::GetExtension($Path).ToLowerInvariant() -ne ".exe") {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant() }
        finally { $sha.Dispose() }
    }

    if ($bytes.Length -lt 256 -or [BitConverter]::ToUInt16($bytes, 0) -ne 0x5A4D) { throw "Executable backend tidak valid: $Path" }
    $peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
    if ($peOffset -lt 0 -or $peOffset + 144 -gt $bytes.Length -or [BitConverter]::ToUInt32($bytes, $peOffset) -ne 0x00004550) {
        throw "Executable backend tidak valid: $Path"
    }
    $optionalOffset = $peOffset + 24
    $magic = [BitConverter]::ToUInt16($bytes, $optionalOffset)
    if ($magic -eq 0x10B) { $dataDirectoryOffset = $optionalOffset + 96 }
    elseif ($magic -eq 0x20B) { $dataDirectoryOffset = $optionalOffset + 112 }
    else { throw "Executable backend tidak valid: $Path" }
    $checksumOffset = $optionalOffset + 64
    $securityDirectoryOffset = $dataDirectoryOffset + 32
    $certificateOffset = [BitConverter]::ToUInt32($bytes, $securityDirectoryOffset)
    $certificateSize = [BitConverter]::ToUInt32($bytes, $securityDirectoryOffset + 4)
    [Array]::Clear($bytes, $checksumOffset, 4)
    [Array]::Clear($bytes, $securityDirectoryOffset, 8)

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        if ($certificateOffset -gt 0 -and $certificateSize -gt 0 -and ($certificateOffset + $certificateSize) -le $bytes.Length) {
            $sha.TransformBlock($bytes, 0, [int]$certificateOffset, $null, 0) | Out-Null
            $tailOffset = [int]($certificateOffset + $certificateSize)
            $tailLength = $bytes.Length - $tailOffset
            $sha.TransformFinalBlock($bytes, $tailOffset, $tailLength) | Out-Null
            return ([BitConverter]::ToString($sha.Hash)).Replace("-", "").ToLowerInvariant()
        }
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
    } finally { $sha.Dispose() }
}

if (-not (Test-Path -LiteralPath $Python)) {
    $RepoPython = Join-Path (Split-Path -Parent $Root) ".venv\Scripts\python.exe"
    $Python = if (Test-Path -LiteralPath $RepoPython) { $RepoPython } else { (Get-Command py -ErrorAction Stop).Source }
}

Push-Location $Root
try {
    $RuntimeConfig = Get-Content -LiteralPath "frontend\electron\runtime-config.cjs" -Raw
    if ($RuntimeConfig -match "CHANGE-ME") {
        throw "Isi gatewayUrl HTTPS production pada frontend\electron\runtime-config.cjs sebelum build."
    }
    if (-not $UnsignedTest -and -not $env:CSC_LINK) {
        throw "CSC_LINK belum tersedia. Untuk build lokal tanpa tanda tangan gunakan: .\build-portable.ps1 -UnsignedTest"
    }
    $BackendBuildTarget = Join-Path $Root "backend-dist\pddikti-backend"
    if (Test-Path -LiteralPath $BackendBuildTarget) {
        Remove-Item -LiteralPath $BackendBuildTarget -Recurse -Force
    }
    if ($Python.EndsWith("py.exe")) {
        & $Python -3 -m pip install -r backend\requirements-build.txt
        & $Python -3 -m PyInstaller --noconfirm --clean --distpath backend-dist\pddikti-backend --workpath build\pyinstaller backend\pddikti-backend.spec
    } else {
        & $Python -m pip install -r backend\requirements-build.txt
        & $Python -m PyInstaller --noconfirm --clean --distpath backend-dist\pddikti-backend --workpath build\pyinstaller backend\pddikti-backend.spec
    }
    if ($LASTEXITCODE -ne 0) { throw "Build backend gagal." }

    $BackendRoot = (Resolve-Path -LiteralPath "backend-dist\pddikti-backend").Path
    $RawPython = Get-ChildItem -LiteralPath $BackendRoot -Recurse -File -Filter "*.py"
    if ($RawPython) { throw "Build dibatalkan: file Python mentah ditemukan pada paket backend." }
    $Files = Get-ChildItem -LiteralPath $BackendRoot -Recurse -File | Sort-Object FullName | ForEach-Object {
        [ordered]@{
            path = $_.FullName.Substring($BackendRoot.Length).TrimStart('\').Replace('\', '/')
            size = $_.Length
            sha256 = Get-IntegritySha256 -Path $_.FullName
        }
    }
    [ordered]@{ algorithm = "sha256-authenticode-normalized"; files = @($Files) } |
        ConvertTo-Json -Depth 4 |
        Set-Content -LiteralPath "frontend\electron\integrity-manifest.json" -Encoding UTF8

    Push-Location frontend
    try {
        if ($UnsignedTest) { $env:PDDIKTI_ALLOW_UNSIGNED_BUILD = "1" }
        else { Remove-Item Env:PDDIKTI_ALLOW_UNSIGNED_BUILD -ErrorAction SilentlyContinue }
        Invoke-Npm ci
        Invoke-Npm run build
        Invoke-Npm run electron:pack
    } finally {
        Pop-Location
    }
} finally {
    Pop-Location
}

Write-Host "Selesai: production\release\PDDIKTI-Scraper-Portable-2.1.0.exe"
Write-Host "Distribusi cukup satu file EXE portable tersebut."
