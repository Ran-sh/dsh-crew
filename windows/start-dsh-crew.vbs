Option Explicit

Dim shell, launcher, command
Set shell = CreateObject("WScript.Shell")
launcher = "__LAUNCHER__"
command = shell.ExpandEnvironmentStrings("%COMSPEC%") & " /d /c " & _
  Chr(34) & Chr(34) & launcher & Chr(34) & " --background" & Chr(34)

shell.Run command, 0, False
