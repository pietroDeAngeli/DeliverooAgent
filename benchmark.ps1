param(
    [int]$RUN_DURATION = 60,
    [string[]]$Maps = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
$BACKEND = Join-Path $ROOT "../Deliveroo.js\backend"
$AGENT = Join-Path $ROOT "Agent"
$GAMES_DIR = Join-Path $ROOT "../Deliveroo.js\packages\@unitn-asa\deliveroo-js-assets\assets\games"
$RESULTS = Join-Path $ROOT "benchmark_results.csv"
$SERVER_URL = "http://localhost:8080"
$AGENTS_API = "$SERVER_URL/api/agents"

$allMaps = Get-ChildItem -Path $GAMES_DIR -Filter "*.json" | Select-Object -ExpandProperty BaseName | Sort-Object

if ($Maps.Count -gt 0) {
    $allMaps = $allMaps | Where-Object { $Maps -contains $_ }
}

if ($allMaps.Count -eq 0) {
    Write-Error "No maps found in $GAMES_DIR"
    exit 1
}

Write-Host "Maps to benchmark ($($allMaps.Count)): $($allMaps -join ', ')"
Write-Host "Duration per map: $RUN_DURATION seconds"
Write-Host "Results file: $RESULTS"
Write-Host ""

"map,score,penalty,net_score,duration_s,timestamp" | Set-Content -Path $RESULTS -Encoding UTF8

function Wait-Server {
    param([int]$TimeoutSec = 30)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $null = Invoke-WebRequest -Uri $SERVER_URL -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            return $true
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    return $false
}

function Get-AgentScore {
    try {
        $response = Invoke-RestMethod -Uri $AGENTS_API -Method Get -TimeoutSec 5 -ErrorAction Stop
        if ($response.Count -gt 0) {
            return $response | Sort-Object -Property score -Descending | Select-Object -First 1
        }
    } catch {
        Write-Warning "Could not reach $AGENTS_API"
    }
    return $null
}

foreach ($map in $allMaps) {

    $mapFile = Join-Path $GAMES_DIR "$map.json"
    Write-Host "-------------------------------------------"
    Write-Host "Map: $map"

    $serverCmd = "npm start -- `"-g=$mapFile`""
    $serverProc = Start-Process -FilePath "cmd.exe" `
        -ArgumentList "/c $serverCmd" `
        -WorkingDirectory $BACKEND `
        -PassThru -NoNewWindow `
        -RedirectStandardOutput (Join-Path $ROOT "server_stdout.log") `
        -RedirectStandardError (Join-Path $ROOT "server_stderr.log")

    Write-Host "  Server PID $($serverProc.Id) starting..."

    if (-not (Wait-Server -TimeoutSec 30)) {
        Write-Warning "  Server did not start in time - skipping $map"
        Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue
        continue
    }
    Write-Host "  Server ready."

    Start-Sleep -Seconds 2

    $agentProc = Start-Process -FilePath "cmd.exe" `
        -ArgumentList "/c", "node", "--experimental-strip-types", "main.ts" `
        -WorkingDirectory $AGENT `
        -PassThru -NoNewWindow `
        -RedirectStandardOutput (Join-Path $ROOT "agent_stdout.log") `
        -RedirectStandardError (Join-Path $ROOT "agent_stderr.log")

    Write-Host "  Agent PID $($agentProc.Id) started. Running for $RUN_DURATION s..."

    $start = Get-Date
    Start-Sleep -Seconds $RUN_DURATION
    $elapsed = [int]((Get-Date) - $start).TotalSeconds

    $agentData = Get-AgentScore
    $score = if ($agentData) { $agentData.score } else { "N/A" }
    $penalty = if ($agentData) { $agentData.penalty } else { "N/A" }
    $net = if ($agentData) { $agentData.score + $agentData.penalty } else { "N/A" }
    $ts = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")

    Write-Host "  Score: $score  |  Penalty: $penalty  |  Net: $net"

    Stop-Process -Id $agentProc.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue

    Get-Process -Name "node", "nodemon" -ErrorAction SilentlyContinue |
        Where-Object { $_.Id -ne $PID } |
        Stop-Process -Force -ErrorAction SilentlyContinue

    Start-Sleep -Seconds 2

    "$map,$score,$penalty,$net,$elapsed,$ts" | Add-Content -Path $RESULTS -Encoding UTF8
}

Write-Host ""
Write-Host "-------------------------------------------"
Write-Host "Benchmark complete. Results in: $RESULTS"
Write-Host ""

Import-Csv -Path $RESULTS | Format-Table -AutoSize
