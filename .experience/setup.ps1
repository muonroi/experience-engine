# Experience Engine — PowerShell launcher for setup.sh
# Finds Git Bash and runs setup.sh through it (not WSL).
#
# Usage:  .\setup.ps1            # or: powershell .experience\setup.ps1
#         .\setup.ps1 --local    # pass flags through
#         .\setup.ps1 --vps     # VPS mode with SSH tunnel
#
# Supported flags (forwarded to setup.sh):
#   --help, -h     Show help
#   --docker       Docker Compose quick start
#   --local        Local Docker Qdrant + Ollama
#   --vps          VPS Qdrant via SSH tunnel
#
# Supported agents: Claude Code, Gemini CLI, Codex CLI, OpenCode
# Note: Codex CLI hooks are disabled on native Windows — use WSL instead.

param([Parameter(ValueFromRemainingArguments)]$passArgs)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$setupSh  = Join-Path $scriptDir "setup.sh"

if (-not (Test-Path $setupSh)) {
    Write-Host "  [ERROR] setup.sh not found at $setupSh" -ForegroundColor Red
    exit 1
}

# Find Git Bash — check common locations
$gitBashPaths = @(
    "$env:ProgramFiles\Git\bin\bash.exe",
    "${env:ProgramFiles(x86)}\Git\bin\bash.exe",
    "$env:LocalAppData\Programs\Git\bin\bash.exe",
    "C:\Program Files\Git\bin\bash.exe"
)

$gitBash = $null
foreach ($p in $gitBashPaths) {
    if (Test-Path $p) { $gitBash = $p; break }
}

# Fallback: check PATH for git, derive bash location
if (-not $gitBash) {
    $gitExe = Get-Command git -ErrorAction SilentlyContinue
    if ($gitExe) {
        $gitDir = Split-Path (Split-Path $gitExe.Source)
        $candidate = Join-Path $gitDir "bin\bash.exe"
        if (Test-Path $candidate) { $gitBash = $candidate }
    }
}

if (-not $gitBash) {
    Write-Host ""
    Write-Host "  [ERROR] Git Bash not found." -ForegroundColor Red
    Write-Host "  Install Git for Windows: https://git-scm.com/download/win"
    Write-Host "  Or run from Git Bash terminal directly: bash .experience/setup.sh"
    Write-Host ""
    exit 1
}

# Convert Windows path to MSYS path for bash
$msysPath = $setupSh -replace '\\','/' -replace '^([A-Za-z]):','/$1'
$msysPath = $msysPath.Substring(0,1) + $msysPath.Substring(1,1).ToLower() + $msysPath.Substring(2)

# Convert CWD to MSYS path
$msysCwd = "$(Get-Location)" -replace '\\','/' -replace '^([A-Za-z]):','/$1'
$msysCwd = $msysCwd.Substring(0,1) + $msysCwd.Substring(1,1).ToLower() + $msysCwd.Substring(2)

# Build args string (properly quoted for bash)
$argStr = if ($passArgs) { ($passArgs | ForEach-Object { "'$_'" }) -join ' ' } else { '' }

Write-Host "  Using Git Bash: $gitBash" -ForegroundColor DarkGray
& $gitBash --login -c "cd '$msysCwd' && bash '$msysPath' $argStr"
exit $LASTEXITCODE
