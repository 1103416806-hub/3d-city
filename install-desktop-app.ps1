$projectFolder = $PSScriptRoot
$desktopFolder = [Environment]::GetFolderPath('Desktop')
$shortcutName = '3D' + [char]0x57CE + [char]0x5E02 + '.lnk'
$shortcutPath = Join-Path $desktopFolder $shortcutName
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$shortcut.Arguments = '"' + (Join-Path $projectFolder 'launch-app.vbs') + '"'
$shortcut.WorkingDirectory = $projectFolder
$shortcut.IconLocation = (Join-Path $projectFolder '3Dcity-v2.ico') + ',0'
$shortcut.Description = 'Open the 3D City spatial scale application'
$shortcut.Save()
Write-Output $shortcutPath
