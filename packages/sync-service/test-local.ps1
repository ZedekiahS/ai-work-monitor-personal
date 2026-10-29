param(
    [string]$PostgresBin = 'C:\Program Files\PostgreSQL\18\bin',
    [int]$Port = 55441
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$fixtureRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'work\pg-personal-test'))
if (-not $fixtureRoot.StartsWith(($projectRoot + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture must remain in project directory.' }
$pgCtl = Join-Path $PostgresBin 'pg_ctl.exe'
$initDb = Join-Path $PostgresBin 'initdb.exe'
if (-not (Test-Path -LiteralPath $pgCtl)) { throw 'PostgreSQL tools not found; pass -PostgresBin.' }
if (-not (Test-Path -LiteralPath (Join-Path $fixtureRoot 'PG_VERSION'))) {
    & $initDb -D $fixtureRoot -U awmfixture -A trust --no-locale -E UTF8 -c shared_buffers=16MB -c max_connections=20
    if ($LASTEXITCODE -ne 0) { throw 'Fixture initdb failed; partial directory preserved for diagnosis.' }
}
$logPath = Join-Path $fixtureRoot 'server.log'
$previousLocation = Get-Location
$previousRun = $env:SYNC_RUN_DB_TESTS
$previousUrl = $env:SYNC_TEST_DATABASE_URL
$started = $false
try {
    $ctl = Start-Process -FilePath $pgCtl -ArgumentList @('-D', ('"' + $fixtureRoot + '"'), '-l', ('"' + $logPath + '"'), '-o', ('"-p ' + $Port + ' -h 127.0.0.1"'), '-w', 'start') -WindowStyle Hidden -PassThru
    if (-not $ctl.WaitForExit(30000)) { throw 'pg_ctl startup timeout; inspect the isolated fixture log.' }
    if ($ctl.ExitCode -ne 0) { throw 'Isolated fixture startup failed; inspect work logs. No existing service is stopped.' }
    $started = $true
    Set-Location -LiteralPath $projectRoot
    $env:SYNC_RUN_DB_TESTS = '1'
    $env:SYNC_TEST_DATABASE_URL = "postgresql://awmfixture@127.0.0.1:$Port/postgres"
    & node --import tsx --test packages/sync-service/test/*.test.ts
    if ($LASTEXITCODE -ne 0) { throw 'Personal sync tests failed. Fixtures and failure evidence are preserved.' }
} finally {
    $env:SYNC_RUN_DB_TESTS = $previousRun
    $env:SYNC_TEST_DATABASE_URL = $previousUrl
    Set-Location -LiteralPath $previousLocation.Path
    if ($started) {
        $stop = Start-Process -FilePath $pgCtl -ArgumentList @('-D', ('"' + $fixtureRoot + '"'), '-m', 'fast', '-w', 'stop') -WindowStyle Hidden -PassThru
        if (-not $stop.WaitForExit(30000)) { Write-Warning 'Isolated fixture shutdown timeout.' }
        if ($stop.ExitCode -ne 0) { Write-Warning 'Fixture shutdown failed; inspect this project test cluster only.' }
    }
}
