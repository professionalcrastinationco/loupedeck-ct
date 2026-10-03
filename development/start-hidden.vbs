' Launches the Loupedeck CT daemon (watchdog) with no console window.
' Used by the "Loupedeck CT" scheduled task. Safe to run repeatedly:
' the watchdog exits immediately if an instance is already running.
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
backend = root & "\backend"

Set shell = CreateObject("WScript.Shell")
node = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If Not fso.FileExists(node) Then node = "node.exe"

shell.CurrentDirectory = backend
shell.Run """" & node & """ """ & backend & "\src\run.js""", 0, False
