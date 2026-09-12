Set shell = CreateObject("WScript.Shell")
appFolder = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
nodePath = "C:\Program Files\nodejs\node.exe"
launcherPath = appFolder & "\launch-app.cjs"
shell.Run Chr(34) & nodePath & Chr(34) & " --preserve-symlinks-main " & Chr(34) & launcherPath & Chr(34), 0, False
