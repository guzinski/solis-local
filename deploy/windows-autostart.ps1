# Run elevated once. Recovers WSL after a crash and refreshes only Solar's ports.
param(
    [Parameter(Mandatory=$true)][string]$RepoPath,
    [string]$Distro = 'Ubuntu',
    [int]$ModbusPort = 502
)
$ErrorActionPreference = 'Stop'
$linuxUser = (& wsl.exe -d $Distro --exec id -un).Trim()
if ($LASTEXITCODE -ne 0 -or !$linuxUser) { throw 'Cannot identify the WSL user.' }
& wsl.exe -d $Distro -u root --exec bash "$RepoPath/scripts/install-capture-service.sh" $linuxUser $RepoPath $ModbusPort
if ($LASTEXITCODE -ne 0) { throw 'Cannot install Solar capture/autostart support.' }
$directory = Join-Path $env:ProgramData 'SolarMonitor'
New-Item -ItemType Directory -Force -Path $directory | Out-Null
$boot = Join-Path $directory 'boot.ps1'
$script = @'
$ErrorActionPreference = 'Stop'
$log = Join-Path $env:ProgramData 'SolarMonitor\boot.log'
$lastIp = ''; $lastLan = ''
while ($true) {
    try {
        $raw = & wsl.exe -d '__DISTRO__' --exec hostname -I
        if ($LASTEXITCODE -ne 0 -or !$raw) { throw 'WSL is not ready.' }
        $ip = $raw.Trim().Split(' ')[0]
        $adapter = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' -and $_.NetAdapter.HardwareInterface } | Select-Object -First 1
        $lan = $adapter.IPv4Address.IPAddress | Select-Object -First 1
        if ($lan -and ($ip -ne $lastIp -or $lan -ne $lastLan)) {
            foreach ($port in @(3100,3101,9443)) {
                if ($lastLan -and $lastLan -ne $lan) {
                    & netsh interface portproxy delete v4tov4 listenaddress=$lastLan listenport=$port | Out-Null
                }
                & netsh interface portproxy add v4tov4 listenaddress=$lan listenport=$port connectaddress=$ip connectport=$port | Out-Null
                if ($LASTEXITCODE -ne 0) { throw "Port forwarding failed: $port" }
                $name = "SolarMonitor-LAN-$port"
                if (Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue) {
                    Get-NetFirewallRule -Name $name | Get-NetFirewallAddressFilter | Set-NetFirewallAddressFilter -LocalAddress $lan -RemoteAddress LocalSubnet
                } else {
                    New-NetFirewallRule -Name $name -DisplayName "Solar Monitor LAN $port" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -LocalAddress $lan -RemoteAddress LocalSubnet -Profile Any | Out-Null
                }
            }
            Start-Service iphlpsvc
            "$(Get-Date -Format s) Solar ports -> WSL $ip, LAN $lan" | Add-Content $log
            $lastIp = $ip; $lastLan = $lan
        }
        & wsl.exe -d '__DISTRO__' --exec systemctl --user start solar-monitor.service solar-mobile.service
        if ($LASTEXITCODE -ne 0) { throw 'Solar user services not ready.' }
        # Keeps the distribution alive. If WSL crashes, this exits and the loop
        # boots it again rather than leaving a completed scheduled task behind.
        & wsl.exe -d '__DISTRO__' --exec sleep 30
        if ($LASTEXITCODE -ne 0) { throw 'WSL stopped; retrying.' }
    } catch {
        "$(Get-Date -Format s) $($_.Exception.Message)" | Add-Content $log
        Start-Sleep -Seconds 10
    }
}
'@
$script.Replace('__DISTRO__', $Distro.Replace("'", "''")) | Set-Content -Encoding UTF8 $boot
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$boot`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
if (Get-ScheduledTask -TaskName 'Solar Monitor' -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName 'Solar Monitor' }
Register-ScheduledTask -TaskName 'Solar Monitor' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Starts Solar, maintains LAN forwarding and recovers WSL after a crash' -Force | Out-Null
Start-ScheduledTask -TaskName 'Solar Monitor'
Write-Host "Solar autostart installed. Log: $directory\boot.log"
