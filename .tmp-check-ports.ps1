$pids = @(13204, 1940, 5108, 14116, 11184)
Write-Output '=== Listen ==='
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $pids -contains $_.OwningProcess } |
    Select-Object LocalAddress, LocalPort, OwningProcess |
    Format-Table -AutoSize
Write-Output '=== All TCP (listen+established) ==='
Get-NetTCPConnection -ErrorAction SilentlyContinue |
    Where-Object { $pids -contains $_.OwningProcess } |
    Select-Object LocalAddress, LocalPort, RemoteAddress, RemotePort, State, OwningProcess |
    Format-Table -AutoSize
Write-Output '=== UDP ==='
Get-NetUDPEndpoint -ErrorAction SilentlyContinue |
    Where-Object { $pids -contains $_.OwningProcess } |
    Select-Object LocalAddress, LocalPort, OwningProcess |
    Format-Table -AutoSize
Write-Output '=== CPU/mem ==='
Get-Process -Id $pids -ErrorAction SilentlyContinue |
    Select-Object Id, ProcessName, StartTime, CPU, WorkingSet64 |
    Format-Table -AutoSize
