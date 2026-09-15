$ErrorActionPreference = 'Stop'

function Normalize-InstalledComponent {
  param(
    [Parameter(Mandatory=$true)][string]$FileName,
    [Parameter(Mandatory=$true)][string]$Destination
  )

  $projectRoot = (Get-Location).Path
  $destFull = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $Destination))
  $relativeCandidates = @(
    "src/components/ui/$FileName",
    "src/components/$FileName",
    "components/ui/$FileName",
    "components/$FileName",
    "@/components/ui/$FileName",
    "@/components/$FileName",
    "@\components\ui\$FileName",
    "@\components\$FileName"
  )

  $source = $null
  foreach ($relative in $relativeCandidates) {
    $full = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $relative))
    if ((Test-Path -LiteralPath $full) -and ($full -ne $destFull)) {
      $source = Get-Item -LiteralPath $full
      break
    }
  }

  if (-not $source) {
    $source = Get-ChildItem -Path (Join-Path $projectRoot 'src') -Recurse -File -Filter $FileName -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -ne $destFull -and $_.FullName -notmatch '[\\/]vendor[\\/]' } |
      Select-Object -First 1
  }

  if (-not $source) {
    $atRoot = Join-Path $projectRoot '@'
    if (Test-Path -LiteralPath $atRoot) {
      $source = Get-ChildItem -LiteralPath $atRoot -Recurse -File -Filter $FileName -ErrorAction SilentlyContinue | Select-Object -First 1
    }
  }

  if (-not $source) {
    throw "Component $FileName tidak ditemukan setelah installer registry selesai."
  }

  $parent = Split-Path -Parent $destFull
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  Copy-Item -LiteralPath $source.FullName -Destination $destFull -Force
  Write-Host "  normalized: $($source.FullName) -> $Destination" -ForegroundColor DarkGray
}

function Install-ShadcnIfMissing {
  param(
    [Parameter(Mandatory=$true)][string]$Label,
    [Parameter(Mandatory=$true)][string]$RegistryItem,
    [Parameter(Mandatory=$true)][string]$FileName,
    [Parameter(Mandatory=$true)][string]$Destination
  )

  if (Test-Path -LiteralPath $Destination) {
    Write-Host "$Label sudah ada - skip." -ForegroundColor DarkGray
    return
  }

  & npx --yes shadcn@latest add $RegistryItem --yes
  if ($LASTEXITCODE -ne 0) {
    throw "$Label gagal diambil dari registry."
  }
  Normalize-InstalledComponent -FileName $FileName -Destination $Destination
}

Write-Host "[1/8] Installing project dependencies..." -ForegroundColor Cyan
& npm install
if ($LASTEXITCODE -ne 0) { throw "npm install gagal." }

Write-Host "[2/8] Magic UI: Number Ticker..." -ForegroundColor Cyan
Install-ShadcnIfMissing -Label 'Magic UI Number Ticker' -RegistryItem '@magicui/number-ticker' -FileName 'number-ticker.tsx' -Destination 'src/components/vendor/magicui/number-ticker.tsx'

Write-Host "[3/8] Magic UI: Animated Circular Progress Bar..." -ForegroundColor Cyan
Install-ShadcnIfMissing -Label 'Magic UI Animated Circular Progress Bar' -RegistryItem '@magicui/animated-circular-progress-bar' -FileName 'animated-circular-progress-bar.tsx' -Destination 'src/components/vendor/magicui/animated-circular-progress-bar.tsx'

Write-Host "[4/8] Magic UI: Terminal..." -ForegroundColor Cyan
Install-ShadcnIfMissing -Label 'Magic UI Terminal' -RegistryItem '@magicui/terminal' -FileName 'terminal.tsx' -Destination 'src/components/vendor/magicui/terminal.tsx'

Write-Host "[5/8] Magic UI: Border Beam..." -ForegroundColor Cyan
Install-ShadcnIfMissing -Label 'Magic UI Border Beam' -RegistryItem '@magicui/border-beam' -FileName 'border-beam.tsx' -Destination 'src/components/vendor/magicui/border-beam.tsx'

Write-Host "[6/8] Magic UI: Blur Fade..." -ForegroundColor Cyan
Install-ShadcnIfMissing -Label 'Magic UI Blur Fade' -RegistryItem '@magicui/blur-fade' -FileName 'blur-fade.tsx' -Destination 'src/components/vendor/magicui/blur-fade.tsx'

Write-Host "[7/8] Aceternity UI: Hover Border Gradient..." -ForegroundColor Cyan
Install-ShadcnIfMissing -Label 'Aceternity Hover Border Gradient' -RegistryItem '@aceternity/hover-border-gradient' -FileName 'hover-border-gradient.tsx' -Destination 'src/components/vendor/aceternity/hover-border-gradient.tsx'

Write-Host "[8/8] React Bits: AnimatedContent TS + Tailwind..." -ForegroundColor Cyan
Install-ShadcnIfMissing -Label 'React Bits AnimatedContent' -RegistryItem '@react-bits/AnimatedContent-TS-TW' -FileName 'AnimatedContent.tsx' -Destination 'src/components/vendor/react-bits/AnimatedContent.tsx'

Write-Host ""
Write-Host "UI components installed. 21st.dev tidak digunakan, jadi tidak ada login." -ForegroundColor Green
Write-Host "Run: npm run dev" -ForegroundColor Green
