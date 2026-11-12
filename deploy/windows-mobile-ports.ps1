param(
    [Parameter(Mandatory=$true)][System.Net.IPAddress]$WslAddress,
    [Parameter(Mandatory=$true)][System.Net.IPAddress]$LanAddress
)
$ErrorActionPreference = 'Stop'
# Run elevated. Forward only the two mobile ports to WSL, on the home LAN.
foreach ($port in @(3101,9443)) {
    & netsh interface portproxy add v4tov4 listenaddress=$LanAddress listenport=$port connectaddress=$WslAddress connectport=$port
    if ($LASTEXITCODE -ne 0) { throw "Could not forward port $port" }
    $name = "SolarMobile-Local-$port"
    if (!(Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -Name $name -DisplayName "Solar mobile LAN $port" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -LocalAddress $LanAddress -RemoteAddress LocalSubnet -Profile Any | Out-Null
    }
}
Start-Service iphlpsvc
